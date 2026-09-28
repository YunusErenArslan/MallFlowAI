"""Yönetim raporları: en yoğun gün/saat/bölge.

Yeni bir ML modeli gerekmiyor — mevcut crowd_readings üzerinden GROUP BY
agregasyonu. Not: mevcut kayan pencere (Faz 4.6) nedeniyle bu rapor her zaman
son ~30 güne dayanır, yıllar süren bir geçmişe değil (bkz. plan dosyasındaki
Faz 7.6 — ayrı uzun-vadeli trend modeli notu).
"""

import pandas as pd
from sqlalchemy.engine import Engine

from .synthetic import DEFAULT_SCALE_NO_CAPACITY

GUN_ISIMLERI = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]


def _load_frame(engine: Engine, mall_id: int) -> pd.DataFrame:
    crowd = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count FROM crowd_readings WHERE mall_id = {int(mall_id)}",
        engine,
        parse_dates=["timestamp"],
    )
    zones = pd.read_sql(
        f"SELECT id AS zone_id, code, name, capacity FROM zones WHERE mall_id = {int(mall_id)} ORDER BY id", engine
    )
    df = crowd.merge(zones, on="zone_id", how="left")
    df["capacity_scale"] = df["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    df["occupancy_pct"] = 100 * df["person_count"] / df["capacity_scale"]
    df["dow"] = df["timestamp"].dt.dayofweek
    df["hour"] = df["timestamp"].dt.hour
    return df


def _week_over_week(df: pd.DataFrame) -> dict | None:
    """Son 7 gün ile ondan önceki 7 günün ortalama doluluğunu karşılaştırır."""
    latest = df["timestamp"].max()
    this_week_start = latest - pd.Timedelta(days=7)
    last_week_start = latest - pd.Timedelta(days=14)

    if df["timestamp"].min() > last_week_start:
        return None  # henüz iki tam hafta birikmedi

    this_week = df[df["timestamp"] > this_week_start]["occupancy_pct"].mean()
    last_week = df[(df["timestamp"] > last_week_start) & (df["timestamp"] <= this_week_start)]["occupancy_pct"].mean()
    if pd.isna(this_week) or pd.isna(last_week) or last_week == 0:
        return None

    return {
        "this_week_avg_pct": round(float(this_week), 1),
        "last_week_avg_pct": round(float(last_week), 1),
        "change_pct": round(float((this_week - last_week) / last_week * 100), 1),
    }


def full_report(engine: Engine, mall_id: int, top_n: int = 5) -> dict:
    df = _load_frame(engine, mall_id)
    if df.empty:
        return {
            "busiest_days": [],
            "busiest_hours": [],
            "busiest_zones": [],
            "quietest_days": [],
            "quietest_hours": [],
            "quietest_zones": [],
            "week_over_week": None,
            "window_days": None,
        }

    by_day = df.groupby("dow")["occupancy_pct"].mean().sort_values(ascending=False)
    by_hour = df.groupby("hour")["occupancy_pct"].mean().sort_values(ascending=False)
    by_zone = df.groupby(["code", "name"])["occupancy_pct"].mean().sort_values(ascending=False)

    return {
        "busiest_days": [
            {"day": GUN_ISIMLERI[int(dow)], "avg_occupancy_pct": round(float(val), 1)}
            for dow, val in by_day.head(top_n).items()
        ],
        "busiest_hours": [
            {"hour": int(hour), "avg_occupancy_pct": round(float(val), 1)} for hour, val in by_hour.head(top_n).items()
        ],
        "busiest_zones": [
            {"zone_code": code, "zone_name": name, "avg_occupancy_pct": round(float(val), 1)}
            for (code, name), val in by_zone.head(top_n).items()
        ],
        "quietest_days": [
            {"day": GUN_ISIMLERI[int(dow)], "avg_occupancy_pct": round(float(val), 1)}
            for dow, val in by_day.tail(top_n).sort_values().items()
        ],
        "quietest_hours": [
            {"hour": int(hour), "avg_occupancy_pct": round(float(val), 1)}
            for hour, val in by_hour.tail(top_n).sort_values().items()
        ],
        "quietest_zones": [
            {"zone_code": code, "zone_name": name, "avg_occupancy_pct": round(float(val), 1)}
            for (code, name), val in by_zone.tail(top_n).sort_values().items()
        ],
        "week_over_week": _week_over_week(df),
        "window_days": int((df["timestamp"].max() - df["timestamp"].min()).total_seconds() // 86400),
    }
