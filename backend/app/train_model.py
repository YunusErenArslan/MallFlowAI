"""Yoğunluk tahmin modellerini eğitir (15/30/45/60 dk ufku için ayrı ayrı).

Kullanım:
    python -m app.train_model
"""

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .database import SessionLocal, engine
from .features import FEATURE_COLUMNS, HORIZONS, build_training_frame
from .models import Mall

ARTIFACTS_ROOT = Path(__file__).resolve().parent.parent / "ml" / "artifacts"


def _artifacts_dir(mall_id: int) -> Path:
    """Faz 8.1: kısa-vadeli model artifact'leri artık AVM'ye göre ayrı
    klasörlerde (`ml/artifacts/{mall_id}/`)."""
    return ARTIFACTS_ROOT / str(mall_id)


def _metrics_path(mall_id: int) -> Path:
    return _artifacts_dir(mall_id) / "metrics.json"


def build_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Zaman bazlı split: son %20 test (leakage olmasın diye rastgele değil, kronolojik)."""
    df = df.sort_values("timestamp")
    cutoff = df["timestamp"].quantile(0.8)
    return df[df["timestamp"] <= cutoff], df[df["timestamp"] > cutoff]


def train_horizon(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon: int):
    target_col = f"target_{horizon}"
    X_train, y_train = train_df[FEATURE_COLUMNS], train_df[target_col]
    X_test, y_test = test_df[FEATURE_COLUMNS], test_df[target_col]

    model = HistGradientBoostingRegressor(
        max_iter=300,
        max_depth=8,
        learning_rate=0.05,
        l2_regularization=0.1,
        random_state=42,
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    mae = float(np.mean(np.abs(preds - y_test)))
    mape = float(np.mean(np.abs(preds - y_test) / y_test.clip(lower=1)) * 100)
    # doluluk yüzde puanı cinsinden hata — MAPE'nin aksine gece saatlerindeki
    # neredeyse-sıfır gerçek değerlerde patlamıyor, diğer modellerle (trend.py)
    # karşılaştırılabilir tek bir "doğruluk %" üretmek için kullanılıyor
    pct_mae = float(np.mean(np.abs(preds - y_test) / test_df["capacity_scale"]) * 100)
    return model, mae, mape, pct_mae


def load_metrics(mall_id: int) -> dict:
    path = _metrics_path(mall_id)
    if path.exists():
        return json.loads(path.read_text())
    return {}


def save_metrics(mall_id: int, metrics: dict) -> None:
    _metrics_path(mall_id).write_text(json.dumps(metrics, indent=2))


def train(mall: Mall) -> dict[int, dict[str, float]]:
    """Manuel/CLI eğitim — her zaman kaydeder (regression guard yok). Otomatik
    haftalık bakım için bkz. maintenance.run_weekly_maintenance (guard'lı)."""
    artifacts_dir = _artifacts_dir(mall.id)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    df = build_training_frame(engine, mall.id)
    if df.empty:
        print(f"{mall.slug}: eğitim verisi yok — önce `generate_historical.generate()` çalıştır.")
        return {}

    train_df, test_df = build_split(df)
    print(f"{mall.slug}: toplam {len(df)} satır | eğitim {len(train_df)} | test {len(test_df)}")

    metrics: dict[int, dict[str, float]] = {}
    persisted_metrics = load_metrics(mall.id)

    for horizon in HORIZONS:
        model, mae, mape, pct_mae = train_horizon(train_df, test_df, horizon)
        print(f"  {horizon:>2} dk ufku -> MAE={mae:.1f} kişi, MAPE=%{mape:.1f}, ±{pct_mae:.1f} puan doluluk")

        joblib.dump(model, artifacts_dir / f"model_{horizon}.joblib")
        metrics[horizon] = {
            "mae": mae,
            "mape": mape,
            "pct_mae": pct_mae,
            "train_rows": len(train_df),
            "test_rows": len(test_df),
        }
        persisted_metrics[str(horizon)] = metrics[horizon]

    save_metrics(mall.id, persisted_metrics)
    print(f"{mall.slug}: modeller kaydedildi: {artifacts_dir}")
    return metrics


if __name__ == "__main__":
    db = SessionLocal()
    try:
        malls = db.query(Mall).order_by(Mall.id).all()
    finally:
        db.close()
    for mall in malls:
        train(mall)
