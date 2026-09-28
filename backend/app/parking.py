"""Otopark modülü: P1/P2/P3 karşılaştırması + öneri.

Otoparklar zaten sıradan zone'lar (parking tipinde) — ayrı bir model/tablo
gerekmiyor, `/predict` ve `/occupancy` altyapısı olduğu gibi çalışıyor. Burada
sadece "hangisini kullanmalıyım" karşılaştırma mantığı var. Tahmin (predict_for_zone)
sadece dolmak üzere olan bir otopark varsa VE sadece o otopark için çağrılır —
her istekte tüm otoparklar için tahmin çekmek gereksiz maliyetli olurdu.
"""

from sqlalchemy.orm import Session

from . import models
from .occupancy import zone_occupancy_snapshot
from .predict import ModelsNotTrainedError, predict_for_zone

FULL_THRESHOLD_PCT = 85
IMMINENT_THRESHOLD_PCT = 95


def parking_status(db: Session, mall_id: int) -> dict:
    snapshot = zone_occupancy_snapshot(db, mall_id)
    lots = [z for z in snapshot if z["zone_type"] == "parking" and z["occupancy_pct"] is not None]
    lots.sort(key=lambda z: z["occupancy_pct"])

    result: dict = {"lots": lots, "recommended": None, "warning": None}
    if not lots:
        return result

    result["recommended"] = {
        "code": lots[0]["code"],
        "name": lots[0]["name"],
        "occupancy_pct": lots[0]["occupancy_pct"],
    }

    fullest = lots[-1]
    if fullest["occupancy_pct"] < FULL_THRESHOLD_PCT or len(lots) < 2:
        return result

    message = f"{fullest['name']} otoparkı dolmak üzere (%{fullest['occupancy_pct']:.0f})."
    try:
        zone = (
            db.query(models.Zone)
            .filter(models.Zone.mall_id == mall_id, models.Zone.code == fullest["code"])
            .first()
        )
        prediction = predict_for_zone(db, zone, mall_id)
        horizon_30 = next(p for p in prediction["predictions"] if p["horizon_minutes"] == 30)
        if horizon_30["predicted_occupancy_pct"] >= IMMINENT_THRESHOLD_PCT:
            message = (
                f"{fullest['name']} otoparkının yaklaşık 30 dakika içerisinde tamamen dolması "
                f"beklenmektedir (%{horizon_30['predicted_occupancy_pct']:.0f})."
            )
    except (ModelsNotTrainedError, StopIteration, AttributeError):
        pass

    message += f" {lots[0]['name']} otoparkını kullanmanız önerilir."
    result["warning"] = message
    return result
