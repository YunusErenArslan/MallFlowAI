"""Model doğruluğu: eğitim-zamanı metrikler (metrics.json) + canlı doğrulama.

Canlı doğrulama, `predictions` tablosundaki geçmiş tahminleri, hedef zamanı
geçmişse `crowd_readings`'teki gerçekleşen değerle karşılaştırır — "modelin
gerçek hayatta ne kadar isabetli olduğu" sorusunun cevabı, eğitim-zamanı MAE'den
farklı olarak sürekli güncellenir.

DÜRÜSTLÜK NOTU (Faz 7.11-7.12): Önce eğitim-zamanı (haftalık sabit anlık
görüntü) ile canlı (her istekte güncel veriyle hesaplanan) arasında canlı
yeterince birikince öne geçen bir "primary" mekanizması kuruldu.

DÜRÜSTLÜK NOTU (Faz 7.13): eğitim-zamanı sayı TAMAMEN KALDIRILDI — asıl
doğruluk canlı olan, eğitim-zamanı sadece onun bir yaklaşıklaması.
`unified_accuracy` artık SADECE
canlı doğruluk döner. Eğitim-zamanı fonksiyonlar (`train_model.load_metrics`,
`anomaly.evaluate_accuracy`/`load_accuracy`, `trend.load_metrics`) hâlâ
mevcut ve kullanılıyor — ama SADECE kendi modüllerinin iç işleyişinde
(regression guard karşılaştırması, artifact kaydı); bu dosyadaki dışa açık
doğruluk görünümünde artık yer almıyorlar.

DÜRÜSTLÜK NOTU (Faz 7.18): Faz 7.13'te eklenen minimum örneklem eşiği
(`*_LIVE_MIN_*`, n≥20) tasarım kararıyla KALDIRILDI.
Artık en az 1 gerçek örnek varsa doğruluk gösteriliyor; hiç örnek yoksa zaten
`accuracy_pct: None` (arayüzde "-"). Bilinen risk açıkça not edilsin: çok
küçük örneklemde (n=1-5) sayı gürültülü/güvenilmez olabilir (Faz 7.8'in n=200
dersi) — ama bu artık kullanıcının bilinçli tercihi, otomatik bir koruma yok.
"""

from datetime import datetime, timedelta

import pandas as pd
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import anomaly, anomaly_tft, models, trend
from .features import HORIZONS
from .risk import occupancy_level
from .synthetic import DEFAULT_SCALE_NO_CAPACITY
from .train_model import load_metrics

MATCH_TOLERANCE_MINUTES = 7


def training_metrics(mall_id: int) -> dict:
    return load_metrics(mall_id)


_EMPTY_HORIZON = {
    "mae": None,
    "pct_mae": None,
    "accuracy_pct": None,
    "sample_count": 0,
    "baseline_pct_mae": None,
    "skill_pct": None,
    "open_pct_mae": None,
    "level_accuracy_pct": None,
    "open_level_accuracy_pct": None,
    "baseline_level_accuracy_pct": None,
}


def _empty_horizons(window_hours: int) -> dict:
    return {"window_hours": window_hours, "horizons": {h: dict(_EMPTY_HORIZON) for h in HORIZONS}}


def live_accuracy(db: Session, mall_id: int, reference_time: datetime, window_hours: int = 24) -> dict:
    """Her ufuk için hem kişi-sayısı hem yüzde-puan (capacity'ye göre normalize,
    eğitim-zamanı pct_mae ile aynı ölçek — karşılaştırılabilir) hata döner.

    VEKTÖRİZE (Faz 7.90): eski sürüm 24 saatlik penceredeki HER tahmin adayı
    için ayrı bir "yakındaki okuma" SQL sorgusu yapıyordu (24 saatte ~26.700
    aday → 26.700 ayrı DB round-trip, `/models/accuracy`'yi ~3.5sn yavaşlatan
    asıl darboğazdı — `anomaly.py`/`trend.py`'de Faz 7.37'de aynı desen zaten
    bulunup düzeltilmişti, bu fonksiyon o zaman gözden kaçmış). `pd.merge_asof`
    (`direction="nearest"`, tolerans) ile TEK seferde eşleştiriliyor. Faz 8.1:
    `mall_id` filtresi zorunlu."""
    window_start = reference_time - timedelta(hours=window_hours)
    conn = db.connection()

    candidates = pd.read_sql(
        "SELECT zone_id, generated_at, horizon_minutes, predicted_count, predicted_occupancy_pct FROM predictions "
        f"WHERE mall_id = {int(mall_id)}",
        conn,
        parse_dates=["generated_at"],
    )
    candidates = candidates[candidates["generated_at"] >= window_start]
    if candidates.empty:
        return _empty_horizons(window_hours)

    candidates = candidates.assign(
        target_timestamp=candidates["generated_at"] + pd.to_timedelta(candidates["horizon_minutes"], unit="m")
    )
    candidates = candidates[candidates["target_timestamp"] <= reference_time]
    if candidates.empty:
        return _empty_horizons(window_hours)

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
        return _empty_horizons(window_hours)

    # Karşılaştırma tabanı ("sabit tahmin"): tahminin yapıldığı andaki gerçek
    # sayı aynen kalır varsayımı. `100 − hata` biçimindeki "doğruluk" bu
    # hiçbir şey öğrenmemiş tahmine bile ~%91-95 verdiği için, modelin asıl
    # katkısı `skill_pct` (bu tabana göre hatayı yüzde kaç azalttığı).
    merged = pd.merge_asof(
        merged.sort_values("generated_at"),
        readings.rename(columns={"actual_timestamp": "generated_ts", "person_count": "count_at_generation"}),
        left_on="generated_at",
        right_on="generated_ts",
        by="zone_id",
        direction="nearest",
        tolerance=pd.Timedelta(minutes=MATCH_TOLERANCE_MINUTES),
    )

    # NOT: `.fillna(DEFAULT_SCALE_NO_CAPACITY)` KULLAN, `capacity or ...` DEĞİL —
    # eksik capacity pandas'ta NaN gelir ve NaN Python'da "truthy"dir (bkz. anomaly.py/trend.py).
    scale = merged["zone_id"].map(zones["capacity"]).fillna(DEFAULT_SCALE_NO_CAPACITY)
    merged = merged.assign(
        actual_pct=100 * merged["person_count"] / scale,
        count_error=(merged["person_count"] - merged["predicted_count"]).abs(),
        baseline_pct_error=(100 * (merged["person_count"] - merged["count_at_generation"]) / scale).abs(),
    )
    merged = merged.assign(pct_error=(merged["actual_pct"] - merged["predicted_occupancy_pct"]).abs())
    # Seviye doğruluğu: tahminin doluluk seviyesi (düşük/orta/yüksek/kritik —
    # ekrandaki renkler) gerçekleşen seviyeyle aynı mı. Operatör için en
    # anlaşılır "doğruluk": "kalabalık olacak mı" sorusunu doğru bildi mi.
    actual_level = merged["actual_pct"].map(occupancy_level)
    merged = merged.assign(
        level_hit=merged["predicted_occupancy_pct"].map(occupancy_level) == actual_level,
        baseline_level_hit=(100 * merged["count_at_generation"] / scale).map(
            lambda v: occupancy_level(v) if pd.notna(v) else None
        )
        == actual_level,
    )
    # Gece (kapalı saatler) doluluk ~0 olduğu için tahmin kolay ve ortalamayı
    # olduğundan iyi gösteriyor — AVM açıkken hata ayrıca raporlanıyor.
    closed_hours = set(db.get(models.Mall, mall_id).closed_hours)
    is_open = ~merged["target_timestamp"].dt.hour.isin(closed_hours)

    result: dict = {"window_hours": window_hours, "horizons": {}}
    for h in HORIZONS:
        sub = merged[merged["horizon_minutes"] == h]
        if len(sub):
            pct_mae = float(sub["pct_error"].mean())
            baseline = float(sub["baseline_pct_error"].mean()) if sub["baseline_pct_error"].notna().any() else None
            open_sub = sub[is_open.loc[sub.index]]
            result["horizons"][h] = {
                "mae": round(float(sub["count_error"].mean()), 1),
                "pct_mae": round(pct_mae, 1),
                "accuracy_pct": round(100 - pct_mae, 1),
                "sample_count": int(len(sub)),
                "baseline_pct_mae": None if baseline is None else round(baseline, 1),
                "skill_pct": round(100 * (1 - pct_mae / baseline), 1) if baseline else None,
                "open_pct_mae": round(float(open_sub["pct_error"].mean()), 1) if len(open_sub) else None,
                "level_accuracy_pct": round(100 * float(sub["level_hit"].mean()), 1),
                "open_level_accuracy_pct": round(100 * float(open_sub["level_hit"].mean()), 1) if len(open_sub) else None,
                "baseline_level_accuracy_pct": round(100 * float(sub["baseline_level_hit"].mean()), 1),
            }
        else:
            result["horizons"][h] = dict(_EMPTY_HORIZON)
    return result


def unified_accuracy(db: Session, mall: "models.Mall") -> dict:
    """Üç modelin doğruluğunu tek, karşılaştırılabilir bir ölçekte (yüzde) döner —
    SADECE canlı (gerçek) doğrulama (bkz. yukarıdaki DÜRÜSTLÜK NOTU, Faz 7.13).
    Minimum örneklem sınırı yok (Faz 7.18) — en az 1 örnek varsa gösterilir,
    hiç örnek yoksa `accuracy_pct: None` (arayüzde "-"). Faz 8.1: `mall`'a
    göre kapsamlandırıldı.
    """
    reference_time = (
        db.query(func.max(models.CrowdReading.timestamp))
        .filter(models.CrowdReading.mall_id == mall.id)
        .scalar()
        or datetime.now()
    )

    # --- kısa-vadeli ---
    short_term_live = live_accuracy(db, mall.id, reference_time)["horizons"]
    live_accs = [v["accuracy_pct"] for v in short_term_live.values() if v["accuracy_pct"] is not None]
    short_term_pct = round(sum(live_accs) / len(live_accs), 1) if live_accs else None
    skills = [v["skill_pct"] for v in short_term_live.values() if v["skill_pct"] is not None]
    errors = [v["pct_mae"] for v in short_term_live.values() if v["pct_mae"] is not None]
    open_errors = [v["open_pct_mae"] for v in short_term_live.values() if v["open_pct_mae"] is not None]

    def _avg(key: str) -> float | None:
        vals = [v[key] for v in short_term_live.values() if v.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    # --- anomali (TFT) ---
    # Başlık sayısı accuracy DEĞİL F1: anomali oranı ~%0.5 olduğu için accuracy
    # "hep normal de" diyen bir modele bile %99.5 verir; F1 hem yakalamayı hem
    # yanlış alarmı birlikte cezalandırır.
    anomaly_live, _ = anomaly_tft.live_summary_and_events(db, mall, limit=0)
    anomaly_live["known_anomalies"] = anomaly_live["true_positives"] + anomaly_live["false_negatives"]
    anomaly_pct = anomaly_live["f1_pct"]
    # Faz 8.29: AVM'ye göre orantılı güvenilirlik eşiği için — bkz.
    # apps/web/src/app/models/page.tsx MIN_RELIABLE_ANOMALY_SAMPLES.
    anomaly_live["total_week_anomalies"] = anomaly.total_week_anomalies(db, mall)

    # --- trend ---
    trend_live = trend.live_accuracy(db, mall.id, reference_time)
    trend_pct = trend_live.get("accuracy_pct")

    return {
        "short_term": {
            "live": short_term_live,
            "accuracy_pct": short_term_pct,
            "skill_pct": round(sum(skills) / len(skills), 1) if skills else None,
            "pct_mae": round(sum(errors) / len(errors), 1) if errors else None,
            "open_pct_mae": round(sum(open_errors) / len(open_errors), 1) if open_errors else None,
            "level_accuracy_pct": _avg("level_accuracy_pct"),
            "open_level_accuracy_pct": _avg("open_level_accuracy_pct"),
            "baseline_level_accuracy_pct": _avg("baseline_level_accuracy_pct"),
        },
        "anomaly": {"live": anomaly_live, "accuracy_pct": anomaly_pct},
        "trend": {"live": trend_live, "accuracy_pct": trend_pct},
    }
