"""Alarm sistemi: mevcut doluluk eşiklerinden uyarı üretir.

Bilinçli olarak ML çağrısı YAPMAZ — occupancy_level (risk.py) zaten anlık
veriden hesaplanıyor, o hazır sonucu kullanıyoruz. Her alarm kontrolünde
tüm zone'lar için tahmin (predict_for_zone) çağırmak hem gereksiz maliyetli
olurdu hem de `predictions` tablosunu (canlı doğrulama için kullandığımız)
gereksiz satırlarla kirletirdi.
"""

ALERT_LEVELS = {"yuksek": "warning", "cok_yuksek": "critical"}


def alerts_from_snapshot(snapshot: list[dict]) -> list[dict]:
    alerts = []
    for zone_data in snapshot:
        severity = ALERT_LEVELS.get(zone_data.get("level"))
        if severity is None:
            continue
        alerts.append(
            {
                "zone_code": zone_data["code"],
                "zone_name": zone_data["name"],
                "floor_name": zone_data.get("floor_name"),
                "occupancy_pct": zone_data["occupancy_pct"],
                "person_count": zone_data.get("person_count"),
                "capacity": zone_data.get("capacity"),
                "level": zone_data["level"],
                "severity": severity,
                "timestamp": zone_data.get("timestamp"),
            }
        )
    alerts.sort(key=lambda a: a["occupancy_pct"], reverse=True)
    return alerts
