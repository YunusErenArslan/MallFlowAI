"""Dashboard KPI'ları için günün o anki özeti.

Şu an içeride kaç kişi var (ve 1 saat önce kaç kişiydi — akış yönü) ve AVM genel
doluluk eğrisi: bugün gerçekleşen (15 dk) + şu andan gün sonuna kadar trend
modelinin tahmini (kat eğrileriyle AYNI yöntem). Karşılaştırmalar Raporlar
sayfasında. Ölçek zil / Raporlar ile AYNI.
"""

import pandas as pd
from sqlalchemy.orm import Session

from . import models
from .synthetic import DEFAULT_SCALE_NO_CAPACITY

HOUR = pd.Timedelta(hours=1)


def dashboard_compare(db: Session, mall: "models.Mall") -> dict:
    conn = db.connection()
    mall_id = int(mall.id)
    fmt = "%Y-%m-%d %H:%M:%S"
    latest = pd.read_sql(f"SELECT MAX(timestamp) AS t FROM crowd_readings WHERE mall_id = {mall_id}", conn, parse_dates=["t"])["t"][0]
    if pd.isna(latest):
        return {"available": False}
    day_start = latest.normalize()
    # son okuma tam gece yarısıysa (ör. canlı hafta 00:00'da bitti) yeni gün henüz
    # tek noktadan ibaret — az önce biten günü göster
    if latest == day_start:
        day_start -= pd.Timedelta(days=1)

    zones = pd.read_sql(f"SELECT id AS zone_id, capacity FROM zones WHERE mall_id = {mall_id}", conn)
    zones["scale"] = zones["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    df = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count FROM crowd_readings WHERE mall_id = {mall_id} "
        f"AND timestamp >= '{min(day_start, latest - HOUR).strftime(fmt)}'",
        conn,
        parse_dates=["timestamp"],
    ).merge(zones, on="zone_id")

    ticks = df.groupby("timestamp").agg(count=("person_count", "sum"), scale=("scale", "sum"))
    ticks["pct"] = 100 * ticks["count"] / ticks["scale"]
    now_row = ticks.loc[latest] if latest in ticks.index else None
    hour_ago_row = ticks.loc[latest - HOUR] if latest - HOUR in ticks.index else None

    # trend tahmini: her bölgenin EN SON serisi, şu andan gün sonuna; AVM geneli = Σkişi ÷ Σölçek
    forecasts = pd.read_sql(
        "SELECT f.zone_id, f.target_timestamp AS timestamp, f.predicted_occupancy_pct FROM trend_forecasts f "
        "JOIN (SELECT zone_id, MAX(generated_at) AS g FROM trend_forecasts "
        f"WHERE mall_id = {mall_id} GROUP BY zone_id) last ON last.zone_id = f.zone_id AND last.g = f.generated_at "
        f"WHERE f.mall_id = {mall_id} AND f.target_timestamp > '{latest.strftime(fmt)}' "
        f"AND f.target_timestamp <= '{(day_start + pd.Timedelta(days=1)).strftime(fmt)}'",
        conn,
        parse_dates=["timestamp"],
    ).merge(zones, on="zone_id")
    forecasts["count"] = forecasts["predicted_occupancy_pct"] * forecasts["scale"] / 100
    fc = forecasts.groupby("timestamp").agg(count=("count", "sum"), scale=("scale", "sum")).sort_index()
    fc["pct"] = 100 * fc["count"] / fc["scale"]

    today = ticks[(ticks.index >= day_start) & (ticks.index <= latest)]
    return {
        "available": True,
        "now": latest.isoformat(),
        "day_start": day_start.isoformat(),
        "inside": {
            "now": int(now_row["count"]) if now_row is not None else None,
            "hour_ago": int(hour_ago_row["count"]) if hour_ago_row is not None else None,
        },
        "occupancy_pct": {"now": round(float(now_row["pct"]), 1) if now_row is not None else None},
        "curve": {
            "today": [
                {"t": t.isoformat(), "pct": round(float(p), 1), "count": int(c)}
                for t, p, c in zip(today.index, today["pct"], today["count"])
            ],
            "forecast": [
                {"t": t.isoformat(), "pct": round(float(p), 1), "count": int(round(c))}
                for t, p, c in zip(fc.index, fc["pct"], fc["count"])
            ],
        },
    }
