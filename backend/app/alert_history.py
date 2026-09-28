"""Bildirim geçmişi — web'deki Bildirimler sayfası için bu haftanın (canlı
simülasyonun şimdiye kadar açığa çıkan kısmının) TÜM bildirimleri.

Zildeki canlı akışla AYNI kurallar kullanılır, böylece sayfa ile zil tutarlı:
- Anomali (TFT) alarmları: `anomaly_tft.recent_anomaly_alerts` — aynı 60 dk
  bekleme kuralı, aynı alanlar.
- Kapasite uyarıları (yüksek/kritik): istemcinin zil mantığının aynısı — bir
  bölgenin uyarı türü bir önceki tick'te yokken bu tick'te varsa YENİ bildirim.
"""

import pandas as pd
from sqlalchemy.orm import Session

from . import anomaly_tft, models
from .alerts import ALERT_LEVELS
from .risk import occupancy_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY, REFERENCE_NOW

MAX_HISTORY = 2000


def capacity_alert_history(db: Session, mall: "models.Mall") -> list[dict]:
    fmt = "%Y-%m-%d %H:%M:%S"
    readings = pd.read_sql(
        "SELECT c.zone_id, c.timestamp, c.person_count, z.code, z.name, z.capacity, f.name AS floor_name "
        "FROM crowd_readings c JOIN zones z ON z.id = c.zone_id JOIN floors f ON f.id = z.floor_id "
        f"WHERE c.mall_id = {int(mall.id)} AND c.timestamp >= '{REFERENCE_NOW.strftime(fmt)}' "
        "ORDER BY c.zone_id, c.timestamp",
        db.connection(),
        parse_dates=["timestamp"],
    )
    alerts: list[dict] = []
    for _, zone_rows in readings.groupby("zone_id", sort=False):
        previous = None
        for row in zone_rows.itertuples():
            capacity = None if pd.isna(row.capacity) else int(row.capacity)
            # `zone_occupancy_snapshot` ile AYNI ölçek ve yuvarlama
            pct = round(100 * row.person_count / (capacity or DEFAULT_SCALE_NO_CAPACITY), 1)
            level = occupancy_level(pct)
            severity = ALERT_LEVELS.get(level)
            if severity is not None and severity != previous:
                alerts.append(
                    {
                        "zone_code": row.code,
                        "zone_name": row.name,
                        "floor_name": row.floor_name,
                        "occupancy_pct": pct,
                        "person_count": int(row.person_count),
                        "capacity": capacity,
                        "level": level,
                        "severity": severity,
                        "timestamp": row.timestamp.isoformat(),
                    }
                )
            previous = severity
    return alerts


def alert_history(db: Session, mall: "models.Mall") -> list[dict]:
    """En yeni üstte; anomali + kapasite birlikte."""
    anomalies = anomaly_tft.recent_anomaly_alerts(db, mall, hours=24 * 8)
    combined = anomalies + capacity_alert_history(db, mall)
    combined.sort(key=lambda a: a["timestamp"], reverse=True)
    return combined[:MAX_HISTORY]
