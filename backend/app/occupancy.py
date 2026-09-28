"""Zone bazlı anlık doluluk hesaplama — hem REST (/occupancy, /dashboard/summary)
hem WebSocket yayını (simulation.py'nin her tick'inden sonra) burayı kullanır.
"""

from sqlalchemy.orm import Session

from . import models
from .alerts import alerts_from_snapshot
from .anomaly_tft import anomaly_alerts, attach_expected_bands
from .boot import BOOT_ID
from .risk import occupancy_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY

LEVEL_RANK = {"dusuk": 0, "orta": 1, "yuksek": 2, "cok_yuksek": 3}


def zone_occupancy_snapshot(db: Session, mall_id: int) -> list[dict]:
    zones = db.query(models.Zone).filter(models.Zone.mall_id == mall_id).all()
    result = []
    for zone in zones:
        latest = (
            db.query(models.CrowdReading)
            .filter(models.CrowdReading.zone_id == zone.id)
            .order_by(models.CrowdReading.timestamp.desc())
            .first()
        )
        base = {
            "zone_id": zone.id,
            "code": zone.code,
            "name": zone.name,
            "zone_type": zone.zone_type,
            "floor_code": zone.floor.code,
            "floor_name": zone.floor.name,
            "floor_level_order": zone.floor.level_order,
            "capacity": zone.capacity,
        }
        if latest is None:
            result.append({**base, "person_count": None, "occupancy_pct": None, "level": None})
            continue

        scale = zone.capacity or DEFAULT_SCALE_NO_CAPACITY
        pct = round(100 * latest.person_count / scale, 1)
        result.append(
            {
                **base,
                "timestamp": latest.timestamp.isoformat(),
                "person_count": latest.person_count,
                "occupancy_pct": pct,
                "level": occupancy_level(pct),
            }
        )
    return result


def dashboard_summary(db: Session, mall: "models.Mall") -> dict:
    all_zones = zone_occupancy_snapshot(db, mall.id)
    attach_expected_bands(db, mall, all_zones)
    snapshot = [z for z in all_zones if z["person_count"] is not None]
    if not snapshot:
        return {
            "total_visitors": 0,
            "total_capacity": sum(z["capacity"] or DEFAULT_SCALE_NO_CAPACITY for z in all_zones),
            "overall_occupancy_pct": 0,
            "busiest_zone": None,
            "riskiest_zone": None,
            "zones": all_zones,
            "alerts": [],
        }

    total_visitors = sum(z["person_count"] for z in snapshot)
    total_scale = sum(z["capacity"] or DEFAULT_SCALE_NO_CAPACITY for z in snapshot)
    overall_pct = round(100 * total_visitors / total_scale, 1) if total_scale else 0

    busiest = max(snapshot, key=lambda z: z["occupancy_pct"])
    riskiest = max(snapshot, key=lambda z: (LEVEL_RANK[z["level"]], z["occupancy_pct"]))

    return {
        # İstemci bunun değiştiğini gördüğü an (backend resetlendi) eski
        # haftaya ait zil bildirimlerini temizler.
        "boot_id": BOOT_ID,
        "total_visitors": total_visitors,
        "total_capacity": total_scale,
        "overall_occupancy_pct": overall_pct,
        "busiest_zone": {"code": busiest["code"], "name": busiest["name"], "occupancy_pct": busiest["occupancy_pct"]},
        "riskiest_zone": {
            "code": riskiest["code"],
            "name": riskiest["name"],
            "occupancy_pct": riskiest["occupancy_pct"],
            "level": riskiest["level"],
        },
        "zones": snapshot,
        "alerts": alerts_from_snapshot(snapshot) + anomaly_alerts(db, mall, snapshot),
    }
