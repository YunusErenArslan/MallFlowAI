"""Canlı tahmin: son veriden feature üretir, kayıtlı modellerle 15/30/45/60 dk tahmin yapar,
risk seviyesi + açıklama + öneri üretir ve `predictions` tablosuna yazar.
"""

import joblib
import pandas as pd
from sqlalchemy.orm import Session

from . import models
from .features import FEATURE_COLUMNS, HORIZONS, build_live_features
from .risk import build_explanation, build_recommendations, occupancy_level, risk_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY
from .train_model import _artifacts_dir

_model_cache: dict[tuple[int, int], object] = {}


class ModelsNotTrainedError(RuntimeError):
    pass


def clear_model_cache() -> None:
    """Yeniden eğitim sonrası eski modelleri bellekten düşürür — sıradaki tahmin
    isteği güncel .joblib dosyalarını diskten yeniden okur."""
    _model_cache.clear()


def _load_model(mall_id: int, horizon: int):
    cache_key = (mall_id, horizon)
    if cache_key in _model_cache:
        return _model_cache[cache_key]
    path = _artifacts_dir(mall_id) / f"model_{horizon}.joblib"
    if not path.exists():
        raise ModelsNotTrainedError(f"model_{horizon}.joblib bulunamadı — önce `train_model.train()` çalıştır.")
    model = joblib.load(path)
    _model_cache[cache_key] = model
    return model


def predict_for_zone(db: Session, zone: models.Zone, mall_id: int) -> dict:
    readings = (
        db.query(models.CrowdReading)
        .filter(models.CrowdReading.zone_id == zone.id)
        .order_by(models.CrowdReading.timestamp.desc())
        .limit(5)
        .all()
    )
    if not readings:
        return {"error": "Bu zone için henüz veri yok."}

    now = readings[0]
    counts = [r.person_count for r in readings] + [readings[-1].person_count] * (5 - len(readings))
    count_now, lag_15, lag_30, lag_45, lag_60 = counts[:5]

    latest_weather = (
        db.query(models.WeatherReading)
        .filter(models.WeatherReading.mall_id == mall_id)
        .order_by(models.WeatherReading.timestamp.desc())
        .first()
    )
    weather_condition = latest_weather.condition if latest_weather else "gunesli"

    active_event = (
        db.query(models.Event)
        .filter(
            models.Event.zone_id == zone.id,
            models.Event.start_time <= now.timestamp,
            models.Event.end_time >= now.timestamp,
        )
        .first()
    )
    has_event = active_event is not None

    now_ts = pd.Timestamp(now.timestamp)
    feature_row = build_live_features(
        zone_type=zone.zone_type,
        capacity=zone.capacity,
        now_ts=now_ts,
        count_now=count_now,
        lag_15=lag_15,
        lag_30=lag_30,
        lag_45=lag_45,
        lag_60=lag_60,
        entries=now.entries,
        exits=now.exits,
        weather_condition=weather_condition,
        has_event=has_event,
    )
    X = pd.DataFrame([feature_row], columns=FEATURE_COLUMNS)

    scale = zone.capacity or DEFAULT_SCALE_NO_CAPACITY
    current_pct = round(100 * count_now / scale, 1)

    horizon_results = []
    for horizon in HORIZONS:
        model = _load_model(mall_id, horizon)
        predicted_count = max(0, round(float(model.predict(X)[0])))
        predicted_pct = round(100 * predicted_count / scale, 1)
        risk = risk_level(current_pct, predicted_pct)
        explanation = build_explanation(
            zone_name=zone.name,
            zone_type=zone.zone_type,
            horizon_minutes=horizon,
            predicted_pct=predicted_pct,
            hour=now_ts.hour,
            is_weekend=bool(feature_row[FEATURE_COLUMNS.index("is_weekend")]),
            weather_condition=weather_condition,
            has_event=has_event,
        )
        recommendations = build_recommendations(zone.zone_type, risk)

        db.add(
            models.Prediction(
                mall_id=mall_id,
                zone_id=zone.id,
                generated_at=now.timestamp,
                horizon_minutes=horizon,
                predicted_count=predicted_count,
                predicted_occupancy_pct=predicted_pct,
                risk_level=risk,
            )
        )

        horizon_results.append(
            {
                "horizon_minutes": horizon,
                "predicted_count": predicted_count,
                "predicted_occupancy_pct": predicted_pct,
                "level": occupancy_level(predicted_pct),
                "risk": risk,
                "explanation": explanation,
                "recommendations": recommendations,
            }
        )

    db.commit()

    return {
        "zone_code": zone.code,
        "zone_name": zone.name,
        "generated_at": now.timestamp.isoformat(),
        "current_count": count_now,
        "current_occupancy_pct": current_pct,
        "predictions": horizon_results,
    }
