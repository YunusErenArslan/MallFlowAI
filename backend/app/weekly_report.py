"""Haftalık karşılaştırma raporu — Raporlar sayfası.

"Bu hafta" = en son okumadan geriye 7 gün, "geçen hafta" = ondan önceki 7 gün
(kayan pencere). Doluluk hep `zone_occupancy_snapshot` ile AYNI ölçekle
hesaplanır (kapasitesi olmayan bölgeler için DEFAULT_SCALE_NO_CAPACITY).

- Ziyaretçi: giriş (entrance) bölgelerinin giriş sayacı toplamı.
- Uyarılar: kapasite uyarıları zil ile AYNI kuralla (bir bölgenin uyarı türü
  yeni başladığında bir uyarı) iki hafta için de sayılır. Anomali (TFT) kararları
  sadece canlı simülasyon için var — geçen hafta için `None`.
"""

import pandas as pd
from sqlalchemy.orm import Session

from . import anomaly_tft, models
from .alerts import ALERT_LEVELS
from .reports import GUN_ISIMLERI
from .risk import occupancy_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY

DAY = pd.Timedelta(days=1)


def _pct_change(now: float | None, before: float | None) -> float | None:
    if now is None or before is None or before == 0:
        return None
    return round(100 * (now - before) / before, 1)


def weekly_report(db: Session, mall: "models.Mall") -> dict:
    conn = db.connection()
    mall_id = int(mall.id)
    zones = pd.read_sql(
        "SELECT z.id AS zone_id, z.code, z.name, z.zone_type, z.capacity, f.name AS floor_name, f.level_order "
        f"FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.mall_id = {mall_id}",
        conn,
    )
    df = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count, entries FROM crowd_readings WHERE mall_id = {mall_id}",
        conn,
        parse_dates=["timestamp"],
    )
    if df.empty or zones.empty:
        return {"available": False}
    zones["scale"] = zones["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    df = df.merge(zones, on="zone_id")
    df["pct"] = 100 * df["person_count"] / df["scale"]

    latest = df["timestamp"].max()
    this_start = latest - 7 * DAY
    last_start = latest - 14 * DAY
    has_last_week = df["timestamp"].min() <= last_start

    def in_this(frame):
        return frame[(frame["timestamp"] > this_start) & (frame["timestamp"] <= latest)]

    def in_last(frame):
        return frame[(frame["timestamp"] > last_start) & (frame["timestamp"] <= this_start)]

    # AVM geneli, tick başına doluluk
    mall_ticks = df.groupby("timestamp").agg(count=("person_count", "sum"), scale=("scale", "sum")).reset_index()
    mall_ticks["pct"] = 100 * mall_ticks["count"] / mall_ticks["scale"]
    entrances = df[df["zone_type"] == "entrance"]

    def visitors(frame):
        return int(frame["entries"].sum())

    def avg(frame):
        return round(float(frame["pct"].mean()), 1) if len(frame) else None

    # --- kapasite uyarıları: zil kuralı (bölgenin uyarı türü yeni başladıysa bir uyarı) ---
    df = df.sort_values(["zone_id", "timestamp"])
    df["severity"] = df["pct"].round(1).map(lambda p: ALERT_LEVELS.get(occupancy_level(p)))
    df["new_alert"] = df["severity"].notna() & (df["severity"] != df.groupby("zone_id")["severity"].shift())

    def capacity_counts(frame):
        new = frame[frame["new_alert"]]
        return {"critical": int((new["severity"] == "critical").sum()), "warning": int((new["severity"] == "warning").sum())}

    anomalies = [
        a for a in anomaly_tft.recent_anomaly_alerts(db, mall, hours=24 * 8) if pd.Timestamp(a["timestamp"]) > this_start
    ]
    this_alerts = {
        **capacity_counts(in_this(df)),
        "increase": sum(1 for a in anomalies if a.get("direction") == "yuksek"),
        "decrease": sum(1 for a in anomalies if a.get("direction") == "dusuk"),
    }
    last_alerts = {**capacity_counts(in_last(df)), "increase": None, "decrease": None} if has_last_week else None

    this_ticks, last_ticks = in_this(mall_ticks), in_last(mall_ticks)
    peak = this_ticks.loc[this_ticks["pct"].idxmax()] if len(this_ticks) else None
    kpis = {
        "visitors": {"this": visitors(in_this(entrances)), "last": visitors(in_last(entrances)) if has_last_week else None},
        "avg_occupancy_pct": {"this": avg(this_ticks), "last": avg(last_ticks) if has_last_week else None},
        "peak": None
        if peak is None
        else {"timestamp": peak["timestamp"].isoformat(), "pct": round(float(peak["pct"]), 1)},
    }
    for k in ("visitors", "avg_occupancy_pct"):
        kpis[k]["change_pct"] = _pct_change(kpis[k]["this"], kpis[k]["last"])

    # --- günlük karşılaştırma: bu haftanın her günü ve geçen haftanın aynı günü ---
    daily = []
    for i in range(7):
        a, b = this_start + i * DAY, this_start + (i + 1) * DAY
        this_day = mall_ticks[(mall_ticks["timestamp"] > a) & (mall_ticks["timestamp"] <= b)]
        last_day = mall_ticks[(mall_ticks["timestamp"] > a - 7 * DAY) & (mall_ticks["timestamp"] <= b - 7 * DAY)]
        ent_this = entrances[(entrances["timestamp"] > a) & (entrances["timestamp"] <= b)]
        ent_last = entrances[(entrances["timestamp"] > a - 7 * DAY) & (entrances["timestamp"] <= b - 7 * DAY)]
        daily.append(
            {
                # pencere (a, b] — a gece yarısıysa gün a'nın günü
                "label": GUN_ISIMLERI[a.dayofweek],
                "date": a.date().isoformat(),
                "this_pct": avg(this_day),
                "last_pct": avg(last_day) if has_last_week else None,
                "this_visitors": visitors(ent_this),
                "last_visitors": visitors(ent_last) if has_last_week else None,
            }
        )

    # --- gün × saat ısı haritası (tüm pencere) ---
    mall_ticks["dow"] = mall_ticks["timestamp"].dt.dayofweek
    mall_ticks["hour"] = mall_ticks["timestamp"].dt.hour
    heat = mall_ticks.groupby(["dow", "hour"])["pct"].mean().reset_index()
    heatmap = [{"dow": int(r.dow), "hour": int(r.hour), "pct": round(float(r.pct), 1)} for r in heat.itertuples()]

    # --- bölge ve kat tabloları ---
    def table(group_cols, label_cols):
        rows = []
        this_df, last_df = in_this(df), in_last(df)
        for key, g in df.groupby(group_cols):
            key = key if isinstance(key, tuple) else (key,)
            mask_this = (this_df[group_cols] == pd.Series(key, index=group_cols)).all(axis=1)
            mask_last = (last_df[group_cols] == pd.Series(key, index=group_cols)).all(axis=1)
            t = this_df[mask_this]
            ll = last_df[mask_last]
            # kat: tick başına kat doluluğu (toplam kişi ÷ toplam ölçek)
            if "zone_id" not in group_cols:
                t = t.groupby("timestamp").agg(c=("person_count", "sum"), s=("scale", "sum"))
                t = t.assign(pct=100 * t["c"] / t["s"])
                ll = ll.groupby("timestamp").agg(c=("person_count", "sum"), s=("scale", "sum"))
                ll = ll.assign(pct=100 * ll["c"] / ll["s"])
            this_avg, last_avg = avg(t), avg(ll) if has_last_week else None
            rows.append(
                {
                    **dict(zip(group_cols, key)),
                    **{c: g[c].iloc[0] for c in label_cols},
                    "this_pct": this_avg,
                    "last_pct": last_avg,
                    "change_pts": None if this_avg is None or last_avg is None else round(this_avg - last_avg, 1),
                    "peak_pct": round(float(t["pct"].max()), 1) if len(t) else None,
                }
            )
        return rows

    zone_rows = table(["zone_id"], ["code", "name", "floor_name", "level_order"])
    for r in zone_rows:
        r["zone_id"] = int(r["zone_id"])
        r["level_order"] = int(r["level_order"])
    floor_rows = table(["level_order"], ["floor_name"])
    for r in floor_rows:
        r["level_order"] = int(r["level_order"])

    return {
        "available": True,
        "has_last_week": bool(has_last_week),
        "this_week": {"start": this_start.isoformat(), "end": latest.isoformat()},
        "last_week": {"start": last_start.isoformat(), "end": this_start.isoformat()},
        "kpis": kpis,
        "alerts": {"this": this_alerts, "last": last_alerts},
        "daily": daily,
        "heatmap": heatmap,
        "zones": sorted(zone_rows, key=lambda r: -(r["this_pct"] or 0)),
        "floors": sorted(floor_rows, key=lambda r: -r["level_order"]),
    }
