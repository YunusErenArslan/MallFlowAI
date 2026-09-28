"""Tahmin modeli için feature engineering.

Hem eğitim (train_model.py, toplu geçmiş veriden) hem de canlı tahmin (predict.py,
tek satırlık "şu an" verisinden) BURADAKİ sabit listeleri ve mantığı kullanır —
train/serve arasında tutarsızlık olmaması için tek doğruluk kaynağı burasıdır.
"""

import pandas as pd
from sqlalchemy.engine import Engine

from .synthetic import DEFAULT_SCALE_NO_CAPACITY, WEATHER_MULTIPLIER, ZONE_TYPE_PEAK_FACTOR

ZONE_TYPES = list(ZONE_TYPE_PEAK_FACTOR.keys())
WEATHER_CONDITIONS = list(WEATHER_MULTIPLIER.keys())

FEATURE_COLUMNS = [
    "hour",
    "dow",
    "is_weekend",
    "count_now",
    "lag_15",
    "lag_30",
    "lag_45",
    "lag_60",
    "entries",
    "exits",
    "capacity_scale",
    "zone_type_code",
    "weather_code",
    "has_event",
]

HORIZONS = (15, 30, 45, 60)
WEEKEND_DOWS = {4, 5, 6}  # Cuma, Cumartesi, Pazar


def zone_type_code(zone_type: str) -> int:
    return ZONE_TYPES.index(zone_type) if zone_type in ZONE_TYPES else -1


def weather_code(condition: str) -> int:
    return WEATHER_CONDITIONS.index(condition) if condition in WEATHER_CONDITIONS else -1


def build_training_frame(engine: Engine, mall_id: int) -> pd.DataFrame:
    """crowd_readings + zones + weather_readings + events'ten eğitim tablosu üretir.
    Faz 8.1: `mall_id` filtresi zorunlu — bu AVM'nin dışındaki hiçbir satır
    eğitim verisine karışmaz."""
    crowd = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count, entries, exits FROM crowd_readings "
        f"WHERE mall_id = {int(mall_id)} ORDER BY timestamp",
        engine,
        parse_dates=["timestamp"],
    )
    zones = pd.read_sql(
        f"SELECT id AS zone_id, zone_type, capacity FROM zones WHERE mall_id = {int(mall_id)} ORDER BY id", engine
    )
    weather = pd.read_sql(
        f"SELECT timestamp, condition FROM weather_readings WHERE mall_id = {int(mall_id)} ORDER BY timestamp",
        engine,
        parse_dates=["timestamp"],
    )
    events = pd.read_sql(
        f"SELECT zone_id, start_time, end_time FROM events WHERE mall_id = {int(mall_id)} ORDER BY start_time",
        engine,
        parse_dates=["start_time", "end_time"],
    )

    df = crowd.merge(zones, on="zone_id", how="left")

    df = df.sort_values("timestamp")
    weather = weather.sort_values("timestamp")
    df = pd.merge_asof(df, weather, on="timestamp", direction="backward")
    df["condition"] = df["condition"].fillna(WEATHER_CONDITIONS[0])

    df["has_event"] = 0
    for zone_id, group in events.groupby("zone_id"):
        mask_zone = df["zone_id"] == zone_id
        for _, ev in group.iterrows():
            window_start = ev["start_time"] - pd.Timedelta(minutes=15)
            window_end = ev["start_time"] + pd.Timedelta(minutes=90)
            mask = mask_zone & df["timestamp"].between(window_start, window_end)
            df.loc[mask, "has_event"] = 1

    df = df.sort_values(["zone_id", "timestamp"]).reset_index(drop=True)
    grouped = df.groupby("zone_id")["person_count"]
    df["count_now"] = df["person_count"]
    df["lag_15"] = grouped.shift(1)
    df["lag_30"] = grouped.shift(2)
    df["lag_45"] = grouped.shift(3)
    df["lag_60"] = grouped.shift(4)
    df["target_15"] = grouped.shift(-1)
    df["target_30"] = grouped.shift(-2)
    df["target_45"] = grouped.shift(-3)
    df["target_60"] = grouped.shift(-4)

    df["hour"] = df["timestamp"].dt.hour
    df["dow"] = df["timestamp"].dt.dayofweek
    df["is_weekend"] = df["dow"].isin(WEEKEND_DOWS).astype(int)
    df["capacity_scale"] = df["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    df["zone_type_code"] = df["zone_type"].apply(zone_type_code)
    df["weather_code"] = df["condition"].apply(weather_code)

    required = FEATURE_COLUMNS + ["target_15", "target_30", "target_45", "target_60", "zone_id", "timestamp"]
    df = df.dropna(subset=required)
    return df[required]


def build_live_features(
    *,
    zone_type: str,
    capacity: int | None,
    now_ts: pd.Timestamp,
    count_now: int,
    lag_15: int,
    lag_30: int,
    lag_45: int,
    lag_60: int,
    entries: int,
    exits: int,
    weather_condition: str,
    has_event: bool,
) -> list[float]:
    """Canlı tahmin için tek satırlık feature vektörü — build_training_frame ile aynı sıra/ölçek."""
    row = {
        "hour": now_ts.hour,
        "dow": now_ts.dayofweek,
        "is_weekend": int(now_ts.dayofweek in WEEKEND_DOWS),
        "count_now": count_now,
        "lag_15": lag_15,
        "lag_30": lag_30,
        "lag_45": lag_45,
        "lag_60": lag_60,
        "entries": entries,
        "exits": exits,
        "capacity_scale": capacity or DEFAULT_SCALE_NO_CAPACITY,
        "zone_type_code": zone_type_code(zone_type),
        "weather_code": weather_code(weather_condition),
        "has_event": int(has_event),
    }
    return [row[col] for col in FEATURE_COLUMNS]
