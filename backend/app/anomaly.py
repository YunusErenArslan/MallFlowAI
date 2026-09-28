"""Anomali tespitinin model-bağımsız ortak parçaları.

IsolationForest (Faz 7.x–8.x, zone başına ayrı model) KALDIRILDI; yerini TFT
aldı (bkz. `anomaly_tft.py`). Kaldırma gerekçesi — aynı canlı hafta üzerinde
ölçüldü: IsolationForest %97 yakalamaya karşın haftada ~450 yanlış alarm
veriyordu (precision ~%8, F1 ~%14); TFT ~%92 yakalamayla 1-3 yanlış alarm
veriyor (F1 ~%95). IsolationForest'ın ayrıntılı deney geçmişi ROADMAP'te.

Burada kalanlar simülatörün (`generate_live_week.py`) ve API'nin de
kullandığı, modelden bağımsız yardımcılar: haftalık ground-truth sayıları ve
"beklenenden yüksek/düşük" yön etiketleri.
"""

from sqlalchemy.orm import Session

from . import models


def total_week_anomalies(db: Session, mall: "models.Mall") -> int:
    """Faz 8.11: bu haftanın TAMAMI için ÖNCEDEN üretilmiş (staged_crowd_readings'teki)
    enjekte anomali sayısı — `known_anomalies` (şimdiye kadar AÇIĞA ÇIKMIŞ
    olan, `_live_check_rows`'tan) ile karıştırılmasın: bu sayı henüz
    gerçekleşmemiş olanları da içeriyor ve reveal bir KOPYALAMA olduğu için
    (bkz. simulation.py) hafta boyunca SABİT kalıyor."""
    return (
        db.query(models.StagedCrowdReading)
        .filter(
            models.StagedCrowdReading.mall_id == mall.id,
            models.StagedCrowdReading.is_injected_anomaly.is_(True),
        )
        .count()
    )


def total_week_normal(db: Session, mall: "models.Mall") -> int:
    """`total_week_anomalies`'in normal karşılığı — bu haftanın TAMAMI için
    ÖNCEDEN üretilmiş (staged_crowd_readings'teki) normal (enjekte edilmemiş)
    okuma sayısı, aynı sebeple (reveal = kopyalama) hafta boyunca SABİT."""
    return (
        db.query(models.StagedCrowdReading)
        .filter(
            models.StagedCrowdReading.mall_id == mall.id,
            models.StagedCrowdReading.is_injected_anomaly.is_(False),
        )
        .count()
    )


# "yuksek"/"dusuk" kısa kodunun tam etiket karşılığı — simülatörün
# ground-truth `direction` sütunu (`generate_live_week.py`) bu etiketleri yazar.
DIRECTION_LABELS = {
    "yuksek": "Beklenmedik Ziyaretçi Artışı",
    "dusuk": "Beklenmedik Ziyaretçi Azalışı",
}
