"""Haftalık tahmin — LSTM (derin öğrenme), t-7/t-14/t-21/t-28 gün lag'leriyle.

Faz 3'ün kısa-vadeli (15/30/45/60dk) modelinden AYRI: burada soru "önümüzdeki
hafta, aynı saatte, geçmiş 4 haftanın örüntüsüne göre ne olur."

Tasarım:
- Girdi 4 elemanlı bir dizi: [t-7gün, t-14gün, t-21gün, t-28gün] — aynı saatteki
  geçmiş değerler. Ham sürekli pencere YOK, sadece bu 4 lag.
- Eğitim verisi GERÇEK `crowd_readings`'ten (Faz 4.6'nın kayan 30 günlük
  penceresi) — sentetik/bellek verisi DEĞİL. 30 günlük pencerede t-28 geçerli
  olabilmesi için sadece pencerenin SON ~2 günü kullanılabilir kaynak satır
  olarak kalıyor; bunu tüm zone'ları TEK bir global modelde havuzlayarak
  (zone_type embedding ile) telafi ediyoruz.
- Faz 4.6'nın haftalık bakım döngüsüne entegre: pencere kaydıkça (eski hafta
  düşer, yeni hafta girer) model otomatik yeniden eğitilir, regression guard
  ile (eskisinden belirgin kötü değilse) devreye alınır.
- Bir sonraki haftanın (7 gün) tahmini: hedef her ne kadar ileride olsa da,
  t-7..t-28 lag'leri hep GEÇMİŞTE (gerçek, gözlemlenmiş) kalıyor — yinelemeli
  (recursive) tahmin yok, hata birikmiyor.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from . import models
from .features import ZONE_TYPES, zone_type_code
from .risk import occupancy_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY

ARTIFACTS_ROOT = Path(__file__).resolve().parent.parent / "ml" / "artifacts"


def _artifacts_dir(mall_id: int) -> Path:
    """Faz 8.1: trend/LSTM artifact'leri artık AVM'ye göre ayrı klasörlerde
    (`ml/artifacts/{mall_id}/trend/`)."""
    return ARTIFACTS_ROOT / str(mall_id) / "trend"


def _metrics_path(mall_id: int) -> Path:
    return _artifacts_dir(mall_id) / "metrics.json"


def _model_path(mall_id: int) -> Path:
    return _artifacts_dir(mall_id) / "model.pt"

STEPS_PER_DAY = 96  # 15dk aralık
LAG_DAYS = (7, 14, 21, 28)
FORECAST_HOURS = 7 * 24
MIN_ROWS_TO_TRAIN = 200
PCT_SCALE = 100.0  # LSTM'e ham yüzde (0-100+) değil, ~[0,1] aralığı verilir — aksi halde
# tanh/sigmoid kapıları doyuma ulaşıp sabit çıktı üretiyor (test sırasında yakalanan bug)

MATCH_TOLERANCE_MINUTES = 30  # trend saatlik çözünürlükte, kısa-vadelinin ±7dk'sından geniş tolerans gerekiyor


class LSTMForecaster(nn.Module):
    """Girdi: [t-7/14/21/28] lag dizisi + zone_type.

    Not (Faz 7.7 sonrası deneyle netleşti): saat/gün'ü ayrıca embedding olarak
    eklemek DENENDİ, sonucu kötüleştirdi (16.24 -> en iyi haliyle 18.43 puan,
    200+ epoch'ta bile). Sebep: t-7/14/21/28 zaten "geçen hafta(lar)ın AYNI
    saati" olduğu için saat/gün bilgisi lag değerlerinin içine dolaylı olarak
    zaten kodulu — ekstra embedding yeni bilgi katmıyor, sadece parametre
    sayısını artırıp aynı küçük veriyle optimizasyonu zorlaştırıyor. Bilinçli
    olarak geri alındı, basit 4 girdili haliyle bırakıldı."""

    def __init__(self, hidden_size: int = 16, n_zone_types: int = len(ZONE_TYPES), zone_embed_dim: int = 4):
        super().__init__()
        self.lstm = nn.LSTM(input_size=1, hidden_size=hidden_size, batch_first=True)
        self.zone_embed = nn.Embedding(n_zone_types, zone_embed_dim)
        self.head = nn.Linear(hidden_size + zone_embed_dim, 1)

    def forward(self, lag_seq: torch.Tensor, zone_type_idx: torch.Tensor) -> torch.Tensor:
        _, (h_n, _) = self.lstm(lag_seq)
        z = self.zone_embed(zone_type_idx)
        combined = torch.cat([h_n[-1], z], dim=1)
        return self.head(combined).squeeze(-1)


def build_lag_frame(engine: Engine, mall_id: int) -> pd.DataFrame:
    crowd = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count FROM crowd_readings "
        f"WHERE mall_id = {int(mall_id)} ORDER BY zone_id, timestamp",
        engine,
        parse_dates=["timestamp"],
    )
    zones = pd.read_sql(
        f"SELECT id AS zone_id, zone_type, capacity FROM zones WHERE mall_id = {int(mall_id)} ORDER BY id", engine
    )
    df = crowd.merge(zones, on="zone_id", how="left")
    df["capacity_scale"] = df["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    df["occupancy_pct"] = 100 * df["person_count"] / df["capacity_scale"]
    df = df.sort_values(["zone_id", "timestamp"]).reset_index(drop=True)

    grouped = df.groupby("zone_id")["occupancy_pct"]
    for d in LAG_DAYS:
        df[f"lag_{d}"] = grouped.shift(d * STEPS_PER_DAY)
    df["zone_type_code"] = df["zone_type"].apply(zone_type_code)

    lag_cols = [f"lag_{d}" for d in LAG_DAYS]
    required = lag_cols + ["zone_type_code", "occupancy_pct"]
    return df.dropna(subset=required)[required + ["timestamp", "zone_id"]]


def train_and_evaluate(
    engine: Engine, mall_id: int, epochs: int = 30, batch_size: int = 64
) -> tuple[nn.Module | None, float | None, int, int]:
    df = build_lag_frame(engine, mall_id)
    if len(df) < MIN_ROWS_TO_TRAIN:
        return None, None, 0, 0

    df = df.sort_values("timestamp")
    split = int(len(df) * 0.85)
    train_df, test_df = df.iloc[:split], df.iloc[split:]

    lag_cols = [f"lag_{d}" for d in LAG_DAYS]

    def to_tensors(part: pd.DataFrame):
        lags = torch.tensor(part[lag_cols].to_numpy(dtype=np.float32) / PCT_SCALE).unsqueeze(-1)
        zone_idx = torch.tensor(part["zone_type_code"].to_numpy(dtype=np.int64))
        target = torch.tensor(part["occupancy_pct"].to_numpy(dtype=np.float32) / PCT_SCALE)
        return lags, zone_idx, target

    X_train, z_train, y_train = to_tensors(train_df)
    X_test, z_test, y_test = to_tensors(test_df)

    model = LSTMForecaster()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.L1Loss()

    model.train()
    n_train = len(X_train)
    for _epoch in range(epochs):
        perm = torch.randperm(n_train)
        for start_i in range(0, n_train, batch_size):
            idx = perm[start_i : start_i + batch_size]
            optimizer.zero_grad()
            pred = model(X_train[idx], z_train[idx])
            loss = loss_fn(pred, y_train[idx])
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        test_pred = model(X_test, z_test)
        test_mae = float(loss_fn(test_pred, y_test).item()) * PCT_SCALE  # tekrar puan (0-100) ölçeğine çevir

    return model, test_mae, len(train_df), len(test_df)


def load_metrics(mall_id: int) -> dict:
    path = _metrics_path(mall_id)
    if path.exists():
        return json.loads(path.read_text())
    return {}


def save_metrics(mall_id: int, metrics: dict) -> None:
    _metrics_path(mall_id).write_text(json.dumps(metrics, indent=2))


def train(engine: Engine, mall: "models.Mall") -> dict:
    """Manuel/CLI eğitim — her zaman kaydeder (regression guard yok, kurulum adımı)."""
    _artifacts_dir(mall.id).mkdir(parents=True, exist_ok=True)
    model, mae, train_n, test_n = train_and_evaluate(engine, mall.id)
    if model is None:
        return {}
    torch.save(model.state_dict(), _model_path(mall.id))
    metrics = {"mae": mae, "train_rows": train_n, "test_rows": test_n}
    save_metrics(mall.id, metrics)
    clear_model_cache()
    return metrics


# Faz 8.1: tekil `LSTMForecaster | None` yerine `mall_id`'ye göre anahtarlanan
# bir sözlük — her AVM'nin kendi bağımsız trend modeli var.
_model_cache: dict[int, LSTMForecaster] = {}


def _load_model(mall_id: int) -> LSTMForecaster | None:
    if mall_id in _model_cache:
        return _model_cache[mall_id]
    path = _model_path(mall_id)
    if not path.exists():
        return None
    model = LSTMForecaster()
    model.load_state_dict(torch.load(path, weights_only=True))
    model.eval()
    _model_cache[mall_id] = model
    return model


def clear_model_cache() -> None:
    _model_cache.clear()


def forecast_next_week(db: Session, zone: models.Zone, mall_id: int) -> list[dict] | None:
    model = _load_model(mall_id)
    if model is None:
        return None

    readings = (
        db.query(models.CrowdReading)
        .filter(models.CrowdReading.zone_id == zone.id)
        .order_by(models.CrowdReading.timestamp)
        .all()
    )
    if not readings:
        return None

    scale = zone.capacity or DEFAULT_SCALE_NO_CAPACITY
    series = pd.Series({r.timestamp: 100 * r.person_count / scale for r in readings}).sort_index()
    hourly = series.resample("1h").mean().ffill()

    latest_ts = readings[-1].timestamp
    zone_idx = torch.tensor([zone_type_code(zone.zone_type)])

    results = []
    for h in range(1, FORECAST_HOURS + 1):
        target_time = latest_ts + timedelta(hours=h)
        lags = [hourly.asof(target_time - timedelta(days=d)) for d in LAG_DAYS]
        if any(pd.isna(v) for v in lags):
            continue
        X = torch.tensor([v / PCT_SCALE for v in lags], dtype=torch.float32).view(1, len(LAG_DAYS), 1)
        with torch.no_grad():
            pred = model(X, zone_idx).item() * PCT_SCALE
        results.append(
            {"timestamp": target_time.isoformat(), "predicted_occupancy_pct": round(max(0.0, pred), 1)}
        )

    # Kısa-vadelinin `predictions` tablosuyla aynı prensip: tahmini SAKLA — hedef
    # saat geçtikçe (canlı akan crowd_readings ile) tek tek, bir hafta beklemeden
    # doğrulanabilsin diye (bkz. live_accuracy).
    if results:
        db.add_all(
            [
                models.TrendForecast(
                    mall_id=mall_id,
                    zone_id=zone.id,
                    generated_at=latest_ts,
                    target_timestamp=datetime.fromisoformat(r["timestamp"]),
                    predicted_occupancy_pct=r["predicted_occupancy_pct"],
                )
                for r in results
            ]
        )
        db.commit()

    return results


def get_forecast_with_actuals(db: Session, zone: models.Zone) -> list[dict] | None:
    """`/trend` sayfası için: en son ÜRETİLMİŞ (kaydedilmiş) haftalık tahmin
    serisini döner. Kendi başına YENİ bir tahmin ÜRETMEZ — tahminler SADECE
    `reset.py`'nin (ve haftalık bakımın) tüm zone'lar için TEK SEFERDE, aynı
    referans zamana göre ürettiği toplu işten (batch job) geliyor (Faz 7.20).
    Sebep: on-demand üretim, farklı zone'ların tahmin pencerelerinin farklı
    anlara çapalanmasına (senkronsuzluğa) yol açıyordu — gerçek sistemlerde
    tahminler böyle zamanlanmış toplu işlerle üretilir, sayfa ziyaretiyle değil.
    Hiç kayıtlı tahmin yoksa None döner (bkz. 503 — normalde reset her zone
    için üretmiş olduğundan bu olmamalı).

    Kayıtlı seri sabit kalır, hedef saati geçen noktalar için gerçekleşen değer
    (canlı akan crowd_readings'ten) otomatik eklenir — zaman geçtikçe
    "gerçekleşen" sütunu dolar. Kişi sayısı (predicted_count/actual_count)
    doluluk yüzdesinin yanında ayrıca döner."""
    latest_batch = (
        db.query(models.TrendForecast.generated_at)
        .filter(models.TrendForecast.zone_id == zone.id)
        .order_by(models.TrendForecast.generated_at.desc())
        .first()
    )
    if latest_batch is None:
        return None

    generated_at = latest_batch[0]
    points = (
        db.query(models.TrendForecast)
        .filter(models.TrendForecast.zone_id == zone.id, models.TrendForecast.generated_at == generated_at)
        .order_by(models.TrendForecast.target_timestamp)
        .all()
    )

    scale = zone.capacity or DEFAULT_SCALE_NO_CAPACITY
    results = []
    for p in points:
        actual_count = None
        actual_occupancy_pct = None
        nearby = (
            db.query(models.CrowdReading)
            .filter(
                models.CrowdReading.zone_id == zone.id,
                models.CrowdReading.timestamp >= p.target_timestamp - timedelta(minutes=MATCH_TOLERANCE_MINUTES),
                models.CrowdReading.timestamp <= p.target_timestamp + timedelta(minutes=MATCH_TOLERANCE_MINUTES),
            )
            .all()
        )
        if nearby:
            actual = min(nearby, key=lambda r: abs((r.timestamp - p.target_timestamp).total_seconds()))
            actual_count = actual.person_count
            actual_occupancy_pct = round(100 * actual.person_count / scale, 1)

        results.append(
            {
                "timestamp": p.target_timestamp.isoformat(),
                "predicted_occupancy_pct": p.predicted_occupancy_pct,
                "predicted_count": round(p.predicted_occupancy_pct * scale / 100),
                "actual_occupancy_pct": actual_occupancy_pct,
                "actual_count": actual_count,
            }
        )
    return results


def get_all_forecasts(db: Session, mall_id: int) -> list[dict]:
    """Faz 7.99: `/trend` sayfasındaki kat krokisi + zaman kaydırıcısı için —
    TÜM zone'ların en son kaydedilmiş haftalık tahmin serisini TEK SEFERDE
    döner. `get_forecast_with_actuals`'ın aksine "gerçekleşen" karşılaştırması
    YOK (bu görünüm ileriye dönük, doğrulama değil) — bu sayede zone başına
    168 satırlık bir "en yakın okuma" sorgusuna hiç gerek kalmıyor.

    Zone başına ayrı SQL sorgusu YOK (bu projede daha önce birkaç kez bulunup
    vektörize edilerek düzeltilen N+1 deseni burada baştan önlendi) — her
    zone'un KENDİ en son `generated_at` grubu tek bir join ile bulunuyor."""
    conn = db.connection()
    zones = pd.read_sql(
        f"SELECT id, code, name, capacity, floor_id FROM zones WHERE mall_id = {int(mall_id)} ORDER BY id", conn
    )
    floors = pd.read_sql(f"SELECT id, code, name, level_order FROM floors WHERE mall_id = {int(mall_id)}", conn)
    zones = zones.merge(floors, left_on="floor_id", right_on="id", suffixes=("", "_floor"))

    latest = pd.read_sql(
        f"SELECT zone_id, MAX(generated_at) AS generated_at FROM trend_forecasts "
        f"WHERE mall_id = {int(mall_id)} GROUP BY zone_id",
        conn,
        parse_dates=["generated_at"],
    )
    forecasts = pd.read_sql(
        f"SELECT zone_id, generated_at, target_timestamp, predicted_occupancy_pct FROM trend_forecasts "
        f"WHERE mall_id = {int(mall_id)}",
        conn,
        parse_dates=["generated_at", "target_timestamp"],
    )
    # sadece her zone'un EN SON ürettiği grup kalsın (eskiler elenir)
    merged = forecasts.merge(latest, on=["zone_id", "generated_at"]).sort_values(["zone_id", "target_timestamp"])

    result = []
    for _, zone in zones.iterrows():
        zone_points = merged[merged["zone_id"] == zone["id"]]
        if zone_points.empty:
            continue
        result.append(
            {
                "code": zone["code"],
                "name": zone["name"],
                "floor_code": zone["code_floor"],
                "floor_name": zone["name_floor"],
                "floor_level_order": int(zone["level_order"]),
                "capacity": None if pd.isna(zone["capacity"]) else int(zone["capacity"]),
                "points": [
                    {
                        "target_timestamp": row["target_timestamp"].isoformat(),
                        "predicted_occupancy_pct": round(float(row["predicted_occupancy_pct"]), 1),
                        "level": occupancy_level(float(row["predicted_occupancy_pct"])),
                    }
                    for _, row in zone_points.iterrows()
                ],
            }
        )
    return result


def live_accuracy(db: Session, mall_id: int, reference_time: datetime, max_samples: int = 1000) -> dict:
    """Kaydedilmiş haftalık tahminlerin (`TrendForecast`) hedef zamanı ÇOKTAN
    GEÇMİŞ olanlarını gerçekleşen crowd_readings ile karşılaştırır — bir hafta
    dolmasını beklemez, her saatlik nokta kendi hedef zamanı geçer geçmez tek
    başına doğrulanır. Kısa-vadelinin aksine sabit bir pencereye bağlı değil
    (trend tahminleri zaten seyrek üretiliyor); en yeni `max_samples` ile sınırlı.

    VEKTÖRİZE (Faz 7.37): eski sürüm her aday tahmin için ayrı bir "yakındaki
    okuma" SQL sorgusu yapıyordu (1000 aday ~0.9sn, `/models/accuracy`'yi
    yavaşlatan asıl darboğazdı) — `pd.merge_asof` (`direction="nearest"`,
    tolerans) ile TEK seferde eşleştiriliyor."""
    conn = db.connection()
    forecasts = pd.read_sql(
        f"SELECT zone_id, target_timestamp, predicted_occupancy_pct FROM trend_forecasts WHERE mall_id = {int(mall_id)}",
        conn,
        parse_dates=["target_timestamp"],
    )
    candidates = (
        forecasts[forecasts["target_timestamp"] <= reference_time]
        .sort_values("target_timestamp", ascending=False)
        .head(max_samples)
    )
    if candidates.empty:
        return {"accuracy_pct": None, "pct_mae": None, "sample_count": 0}

    zones = pd.read_sql(
        f"SELECT id, capacity FROM zones WHERE mall_id = {int(mall_id)} ORDER BY id", conn
    ).set_index("id")
    readings = pd.read_sql(
        f"SELECT zone_id, timestamp AS actual_timestamp, person_count FROM crowd_readings WHERE mall_id = {int(mall_id)}",
        conn,
        parse_dates=["actual_timestamp"],
    ).sort_values("actual_timestamp")

    merged = pd.merge_asof(
        candidates.sort_values("target_timestamp"),
        readings,
        left_on="target_timestamp",
        right_on="actual_timestamp",
        by="zone_id",
        direction="nearest",
        tolerance=pd.Timedelta(minutes=MATCH_TOLERANCE_MINUTES),
    )
    merged = merged.dropna(subset=["person_count"])
    if merged.empty:
        return {"accuracy_pct": None, "pct_mae": None, "sample_count": 0}

    # NOT: `.fillna(DEFAULT_SCALE_NO_CAPACITY)` KULLAN, `capacity or ...` DEĞİL —
    # eksik capacity pandas'ta NaN gelir ve NaN Python'da "truthy"dir.
    scale = merged["zone_id"].map(zones["capacity"]).fillna(DEFAULT_SCALE_NO_CAPACITY)
    actual_pct = 100 * merged["person_count"] / scale
    pct_mae = float((actual_pct - merged["predicted_occupancy_pct"]).abs().mean())
    return {"accuracy_pct": round(100 - pct_mae, 1), "pct_mae": round(pct_mae, 1), "sample_count": int(len(merged))}
