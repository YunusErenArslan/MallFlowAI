"""Faz 8.1: çoklu AVM desteği — her AVM kendi açılış/kapanış saatine, hafta
sonu/hava çarpanına ve saatlik doluluk eğrisine sahip. Önceden bu değerler
synthetic.py/anomaly.py'de TEK bir AVM'ye göre sabit kodlanmıştı (HOURLY_CURVE,
WEEKEND_WEEKDAYS, CLOSED_HOURS vb.) — artık her AVM'nin kendi `Mall` satırından
okunup bu değişmez (frozen) `MallConfig` nesnesine dönüştürülüyor, ve
synthetic.py/anomaly.py'deki fonksiyonlar bunu ZORUNLU parametre olarak alıyor
(modül seviyesi sabit yok — her çağrı noktası bilinçli olarak hangi AVM için
çalıştığını belirtmek zorunda)."""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from . import models


@dataclass(frozen=True)
class MallConfig:
    hourly_curve: tuple[float, ...]
    weekend_weekdays: frozenset[int]
    weekend_multiplier: float
    closed_hours: frozenset[int]
    closed_hour_anomaly_threshold_pct: float
    opening_hour: int
    closing_hour: int


def mall_config_from_row(mall: "models.Mall") -> MallConfig:
    return MallConfig(
        hourly_curve=tuple(mall.hourly_curve),
        weekend_weekdays=frozenset(mall.weekend_weekdays),
        weekend_multiplier=mall.weekend_multiplier,
        closed_hours=frozenset(mall.closed_hours),
        closed_hour_anomaly_threshold_pct=mall.closed_hour_anomaly_threshold_pct,
        opening_hour=mall.opening_hour,
        closing_hour=mall.closing_hour,
    )


def closed_hours_for(opening_hour: int, closing_hour: int) -> frozenset[int]:
    """Açık pencerenin ([opening_hour, closing_hour)) tümleyeni. Mall A için
    (9, 22) verildiğinde eski sabit CLOSED_HOURS = {22,23} ∪ range(0,9) ile
    BİREBİR aynı kümeyi üretir — bkz. reset.py'deki regresyon doğrulaması
    (Faz 8.1).

    DENEME (Faz 8.26, GERİ ALINDI): geçiş saatlerini (8, 22, 23) dışarıda
    bırakan Faz 7.115'in dar kümesi geri getirilip test edildi — TAM BİTEN
    haftada Mall A'da yakalama %78.9'dan %71.1'e DÜŞTÜ (yanlış alarm da
    %5.35'ten %4.06'ya düştü ama bu, projenin öncelik verdiği yakalama
    pahasına oldu — bkz. Faz 7.113 "yakalamaya öncelik verildi" kararı),
    Mall B'de de net kazanç yoktu (yanlış alarm arttı). Sebep: dar küme,
    saat 8/22/23'teki `_is_closed_hour_anomaly` zorunlu geçersiz kılmasını
    (bazı GERÇEK anomalileri modelin kendi kararından bağımsız yakalayan bir
    güvenlik ağı) kaldırıyor — hem yanlış alarmlar hem bazı gerçek
    yakalamalar birlikte düşüyor, net kazanç değil. GERİ ALINDI, geniş küme
    (mevcut davranış) korunuyor."""
    return frozenset(set(range(24)) - set(range(opening_hour, closing_hour)))
