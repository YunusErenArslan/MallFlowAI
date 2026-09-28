"""Sabit boyutlu (rolling) eğitim penceresi.

Yeni veri girdikçe TRAINING_WINDOW_DAYS'ten eski satırlar silinir — böylece
crowd_readings/weather_readings/events hep aynı miktarda veri taşır, sınırsız
büyümez ve model her yeniden eğitildiğinde hep "son N gün" ile eğitilir.
"""

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from . import models

TRAINING_WINDOW_DAYS = 30
MAINTENANCE_INTERVAL_DAYS = 7  # bu periyotta hem eski veri silinir hem model yeniden denenir (bkz. maintenance.py)


def prune_old_data(db: Session, mall_id: int, reference_time: datetime) -> int:
    """Faz 8.1: `mall_id` filtresi zorunlu — aksi halde bir AVM'nin bakım
    döngüsü diğer AVM'nin verisini de silerdi."""
    cutoff = reference_time - timedelta(days=TRAINING_WINDOW_DAYS)

    deleted = (
        db.query(models.CrowdReading)
        .filter(models.CrowdReading.mall_id == mall_id, models.CrowdReading.timestamp < cutoff)
        .delete(synchronize_session=False)
    )
    db.query(models.WeatherReading).filter(
        models.WeatherReading.mall_id == mall_id, models.WeatherReading.timestamp < cutoff
    ).delete(synchronize_session=False)
    db.query(models.Event).filter(models.Event.mall_id == mall_id, models.Event.start_time < cutoff).delete(
        synchronize_session=False
    )

    db.commit()
    return deleted
