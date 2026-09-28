"""Haftalık otomatik bakım: veri penceresini sabit tutar + modeli sadece
gerçekten iyileşiyorsa (ya da ilk eğitimse) devreye alır.

Fixed-schedule kör retrain yerine basit bir "regression guard" uygular: yeni
eğitilen model, mevcut devrede olandan MAE_TOLERANCE'tan daha kötüyse reddedilir,
eski model kalmaya devam eder. Bkz. plan dosyasındaki Faz 4.7 notu.
"""

from datetime import datetime

import joblib
import torch

from . import models, predict, trend
from .database import SessionLocal, engine
from .features import HORIZONS, build_training_frame
from .retention import prune_old_data
from .train_model import _artifacts_dir, build_split, load_metrics, save_metrics, train_horizon

MAE_TOLERANCE = 1.05  # yeni model en fazla %5 daha kötü olabilir, aşarsa reddedilir


def run_weekly_maintenance(mall: "models.Mall", reference_time: datetime) -> dict:
    """Faz 8.1: `mall` parametresi zorunlu — bakım artık AVM başına ÇALIŞIYOR
    (simulation.py, her AVM'nin kendi bakım döngüsünü kendi sim_time'ına göre
    bağımsız tetikliyor)."""
    artifacts_dir = _artifacts_dir(mall.id)
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    db = SessionLocal()
    try:
        deleted_rows = prune_old_data(db, mall.id, reference_time)
    finally:
        db.close()

    summary: dict = {"reference_time": reference_time.isoformat(), "deleted_rows": deleted_rows, "horizons": {}}

    df = build_training_frame(engine, mall.id)
    if df.empty:
        return summary

    train_df, test_df = build_split(df)
    previous_metrics = load_metrics(mall.id)
    new_metrics = dict(previous_metrics)

    for horizon in HORIZONS:
        model, mae, mape, pct_mae = train_horizon(train_df, test_df, horizon)
        old_mae = previous_metrics.get(str(horizon), {}).get("mae")
        promote = old_mae is None or mae <= old_mae * MAE_TOLERANCE

        if promote:
            joblib.dump(model, artifacts_dir / f"model_{horizon}.joblib")
            new_metrics[str(horizon)] = {
                "mae": mae,
                "mape": mape,
                "pct_mae": pct_mae,
                "train_rows": len(train_df),
                "test_rows": len(test_df),
                "trained_at": reference_time.isoformat(),
            }

        summary["horizons"][horizon] = {
            "promoted": promote,
            "new_mae": mae,
            "previous_mae": old_mae,
        }

    save_metrics(mall.id, new_metrics)
    predict.clear_model_cache()

    # Anomali tespiti (TFT) haftalık bakımda yeniden EĞİTİLMİYOR: eğitimi
    # dakikalar sürüyor ve simülasyon döngüsünü bloklardı; model reset'te
    # kurulur (bkz. `anomaly_tft.ensure_trained`). Eskiden burada yeniden
    # eğitilen IsolationForest kaldırıldı.

    # Haftalık trend (LSTM): regression guard'lı, kısa-vadeli modelle aynı mantık.
    trend_model, trend_mae, train_n, test_n = trend.train_and_evaluate(engine, mall.id)
    previous_trend_metrics = trend.load_metrics(mall.id)
    old_trend_mae = previous_trend_metrics.get("mae")
    trend_promote = trend_model is not None and (old_trend_mae is None or trend_mae <= old_trend_mae * MAE_TOLERANCE)

    if trend_promote:
        trend._artifacts_dir(mall.id).mkdir(parents=True, exist_ok=True)
        torch.save(trend_model.state_dict(), trend._model_path(mall.id))
        trend.save_metrics(mall.id, {"mae": trend_mae, "train_rows": train_n, "test_rows": test_n})
        trend.clear_model_cache()

    summary["trend_model"] = {
        "promoted": trend_promote,
        "new_mae": trend_mae,
        "previous_mae": old_trend_mae,
    }

    # Her hafta tüm zone'lar için taze bir haftalık tahmin üret + kaydet — böylece
    # trend.live_accuracy'nin karşılaştıracağı veri sadece /trend sayfası
    # ziyaretlerine değil, düzenli bir kaynağa da bağlı olsun.
    db = SessionLocal()
    try:
        for zone in db.query(models.Zone).filter(models.Zone.mall_id == mall.id).order_by(models.Zone.id).all():
            trend.forecast_next_week(db, zone, mall.id)
    finally:
        db.close()

    return summary
