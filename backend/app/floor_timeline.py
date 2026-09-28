"""Kat bazlı gün akışı — Dashboard'daki kat görünümünün küçük eğrileri için.

Her kat için simüle "bugün"ün (en son okumanın günü) başından şu ana kadarki
gerçekleşen doluluk (15 dk'lık) ve şu andan gün sonuna kadarki tahmin
(haftalık trend modelinin saatlik tahminleri). Kat doluluğu = kattaki tüm
bölgelerin kişi sayısı ÷ toplam ölçek — `zone_occupancy_snapshot` ile AYNI
ölçek (kapasitesi olmayan bölgeler için DEFAULT_SCALE_NO_CAPACITY).
"""

import pandas as pd
from sqlalchemy.orm import Session

from . import models
from .synthetic import DEFAULT_SCALE_NO_CAPACITY


def floor_timeline(db: Session, mall: "models.Mall") -> list[dict]:
    conn = db.connection()
    mall_id = int(mall.id)
    zones = pd.read_sql(
        "SELECT z.id AS zone_id, z.capacity, f.code AS floor_code, f.name AS floor_name, f.level_order "
        f"FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.mall_id = {mall_id}",
        conn,
    )
    if zones.empty:
        return []
    zones["scale"] = zones["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    latest = pd.read_sql(f"SELECT MAX(timestamp) AS t FROM crowd_readings WHERE mall_id = {mall_id}", conn, parse_dates=["t"])["t"][0]
    if pd.isna(latest):
        return []
    day_start = latest.normalize()
    # son okuma tam gece yarısıysa (ör. canlı hafta 00:00'da bitti) yeni gün henüz
    # tek noktadan ibaret — az önce biten günü göster
    if latest == day_start:
        day_start -= pd.Timedelta(days=1)
    day_end = day_start + pd.Timedelta(days=1)
    fmt = "%Y-%m-%d %H:%M:%S"

    readings = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count FROM crowd_readings WHERE mall_id = {mall_id} "
        f"AND timestamp >= '{day_start.strftime(fmt)}'",
        conn,
        parse_dates=["timestamp"],
    ).merge(zones, on="zone_id")
    actual = (
        readings.groupby(["floor_code", "timestamp"])
        .agg(count=("person_count", "sum"), scale=("scale", "sum"))
        .reset_index()
    )
    actual["pct"] = 100 * actual["count"] / actual["scale"]

    # Trend tahminleri: her bölgenin EN SON üretilmiş serisi, şu andan gün sonuna
    forecasts = pd.read_sql(
        "SELECT f.zone_id, f.target_timestamp AS timestamp, f.predicted_occupancy_pct FROM trend_forecasts f "
        "JOIN (SELECT zone_id, MAX(generated_at) AS g FROM trend_forecasts "
        f"WHERE mall_id = {mall_id} GROUP BY zone_id) last ON last.zone_id = f.zone_id AND last.g = f.generated_at "
        f"WHERE f.mall_id = {mall_id} AND f.target_timestamp > '{latest.strftime(fmt)}' "
        f"AND f.target_timestamp <= '{day_end.strftime(fmt)}'",
        conn,
        parse_dates=["timestamp"],
    ).merge(zones, on="zone_id")
    forecasts["count"] = forecasts["predicted_occupancy_pct"] * forecasts["scale"] / 100
    forecast = (
        forecasts.groupby(["floor_code", "timestamp"]).agg(count=("count", "sum"), scale=("scale", "sum")).reset_index()
    )
    forecast["pct"] = 100 * forecast["count"] / forecast["scale"]

    result = []
    floors = zones.drop_duplicates("floor_code").sort_values("level_order", ascending=False)
    for floor in floors.itertuples():
        a = actual[actual["floor_code"] == floor.floor_code].sort_values("timestamp")
        f = forecast[forecast["floor_code"] == floor.floor_code].sort_values("timestamp")
        result.append(
            {
                "floor_code": floor.floor_code,
                "floor_name": floor.floor_name,
                "level_order": int(floor.level_order),
                "day_start": day_start.isoformat(),
                "now": latest.isoformat(),
                "actual": [{"t": t.isoformat(), "pct": round(float(p), 1)} for t, p in zip(a["timestamp"], a["pct"])],
                "forecast": [{"t": t.isoformat(), "pct": round(float(p), 1)} for t, p in zip(f["timestamp"], f["pct"])],
            }
        )
    return result
