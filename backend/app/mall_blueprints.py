"""Faz 8.1: çoklu AVM desteği için AVM şablonları (blueprint). Her şablon,
seed_zones.py/seed_stores.py'nin parametrikleştirilmiş `seed_mall_zones()`/
`seed_mall_stores()` fonksiyonlarına beslenen, o AVM'nin TÜM kimliğini
(katlar, zone'lar, mağazalar, açılış/kapanış saati, doluluk eğrisi) taşıyan
sabit bir veri yapısı.

MALL_BLUEPRINTS listesinin SIRASI DETERMİNİZM AÇISINDAN KRİTİK — reset.py bu
listeyi sırayla dolaşıp her AVM'yi eğitiyor, paylaşılan `synthetic.rng`/torch
RNG durumu AVM'ler arası devam ediyor. Sıra değişirse (yeni bir AVM eklense
bile listenin BAŞINA değil SONUNA eklenmeli) Mall A'nın kendi sayıları bile
kayar — bkz. reset.py'deki ilgili not."""

from dataclasses import dataclass, field

from .synthetic import MALL_A_HOURLY_CURVE, generate_hourly_curve
from .mall_config import closed_hours_for


@dataclass(frozen=True)
class FloorBlueprint:
    code: str
    name: str
    level_order: int


@dataclass(frozen=True)
class ZoneBlueprint:
    code: str
    name: str
    floor_code: str
    zone_type: str
    capacity: int | None


@dataclass(frozen=True)
class StoreBlueprint:
    name: str
    category: str
    zone_code: str


@dataclass(frozen=True)
class MallBlueprint:
    slug: str
    name: str
    opening_hour: int
    closing_hour: int
    weekend_weekdays: frozenset[int]
    weekend_multiplier: float
    hourly_curve: list[float]
    closed_hour_anomaly_threshold_pct: float
    floors: tuple[FloorBlueprint, ...]
    zones: tuple[ZoneBlueprint, ...]
    stores: tuple[StoreBlueprint, ...] = field(default_factory=tuple)

    @property
    def closed_hours(self) -> frozenset[int]:
        return closed_hours_for(self.opening_hour, self.closing_hour)


# --- Mall A: mevcut/ilk AVM — değerleri AYNEN korunuyor (Faz 7.x'in tüm ayar
# geçmişi hâlâ geçerli, bkz. anomaly.py/synthetic.py docstring'leri) ---------
MALL_A = MallBlueprint(
    slug="mall-a",
    name="MallFlow AVM",
    opening_hour=9,
    closing_hour=22,
    weekend_weekdays=frozenset({4, 5, 6}),  # Cuma, Cumartesi, Pazar
    weekend_multiplier=1.25,
    hourly_curve=list(MALL_A_HOURLY_CURVE),
    closed_hour_anomaly_threshold_pct=8.0,
    floors=(
        FloorBlueprint("KAT_-1", "-1. Kat (Otopark)", -1),
        FloorBlueprint("ZEMIN", "Zemin Kat", 0),
        FloorBlueprint("KAT_1", "1. Kat", 1),
        FloorBlueprint("KAT_2", "2. Kat", 2),
    ),
    zones=(
        ZoneBlueprint("ZONE_001", "Ana Giriş", "ZEMIN", "entrance", None),
        ZoneBlueprint("ZONE_004", "Teknoloji Bölgesi", "ZEMIN", "retail", 250),
        ZoneBlueprint("ZONE_005", "Moda Bölgesi", "ZEMIN", "retail", 300),
        ZoneBlueprint("ZONE_006", "Danışma", "ZEMIN", "info_desk", 20),
        ZoneBlueprint("ZONE_007", "Yürüyen Merdiven (Zemin)", "ZEMIN", "walkway", None),
        ZoneBlueprint("ZONE_008", "Moda Mağazaları", "KAT_1", "retail", 350),
        ZoneBlueprint("ZONE_009", "Çocuk Alanı", "KAT_1", "kids_area", 150),
        ZoneBlueprint("ZONE_010", "Kafeler", "KAT_1", "retail", 200),
        ZoneBlueprint("ZONE_002", "Food Court", "KAT_2", "food_court", 600),
        ZoneBlueprint("ZONE_003", "Sinema", "KAT_2", "cinema", 400),
        ZoneBlueprint("ZONE_011", "Eğlence Alanı", "KAT_2", "entertainment", 250),
        ZoneBlueprint("ZONE_012", "Otopark P1", "KAT_-1", "parking", 350),
        ZoneBlueprint("ZONE_013", "Otopark P2", "KAT_-1", "parking", 280),
        ZoneBlueprint("ZONE_014", "Otopark P3", "KAT_-1", "parking", 170),
    ),
    stores=(
        StoreBlueprint("Starbucks", "kahve", "ZONE_010"),
        StoreBlueprint("EspressoLab", "kahve", "ZONE_010"),
        StoreBlueprint("Kahve Dünyası", "kahve", "ZONE_010"),
        StoreBlueprint("Burger King", "yemek", "ZONE_002"),
        StoreBlueprint("Köfteci Yusuf", "yemek", "ZONE_002"),
        StoreBlueprint("Mado", "tatlı", "ZONE_002"),
        StoreBlueprint("Zara", "moda", "ZONE_005"),
        StoreBlueprint("H&M", "moda", "ZONE_005"),
        StoreBlueprint("Sephora", "kozmetik", "ZONE_005"),
        StoreBlueprint("Nike", "moda", "ZONE_008"),
        StoreBlueprint("Adidas", "moda", "ZONE_008"),
        StoreBlueprint("LC Waikiki", "moda", "ZONE_008"),
        StoreBlueprint("Apple Store", "teknoloji", "ZONE_004"),
        StoreBlueprint("Samsung", "teknoloji", "ZONE_004"),
        StoreBlueprint("MediaMarkt", "teknoloji", "ZONE_004"),
    ),
)


# --- Mall B: yeni, kasıtlı olarak Mall A'dan FARKLI ikinci test AVM'si —
# farklı zone sayısı (7 vs 14), farklı kapasite aralığı (15-220 vs 20-600),
# farklı açılış/kapanış saati (10-23 vs 9-22), sinema YOK (generate_historical/
# simulation'daki "en fazla 1 sinema zone'u" varsayımının None yolunu test
# eder), katlar BİLEREK Mall A ile AYNI kodları (ZEMIN/KAT_1) tekrar
# kullanıyor — bileşik (mall_id, code) benzersizlik kısıtının gerçekten
# çalıştığını kanıtlamak için. ---------------------------------------------
MALL_B = MallBlueprint(
    slug="mall-b",
    name="Şehir Plaza",
    opening_hour=10,
    closing_hour=23,
    weekend_weekdays=frozenset({4, 5, 6}),
    weekend_multiplier=1.25,
    hourly_curve=generate_hourly_curve(10, 23),
    closed_hour_anomaly_threshold_pct=8.0,
    floors=(
        FloorBlueprint("ZEMIN", "Zemin Kat", 0),
        FloorBlueprint("KAT_1", "1. Kat", 1),
    ),
    zones=(
        ZoneBlueprint("B_ENTRANCE", "Giriş Holü", "ZEMIN", "entrance", None),
        ZoneBlueprint("B_RETAIL_1", "Moda Katı", "ZEMIN", "retail", 180),
        ZoneBlueprint("B_INFO", "Danışma", "ZEMIN", "info_desk", 15),
        ZoneBlueprint("B_WALKWAY", "Yürüyen Merdiven", "ZEMIN", "walkway", None),
        ZoneBlueprint("B_FOODCOURT", "Lezzet Durağı", "KAT_1", "food_court", 220),
        ZoneBlueprint("B_KIDS", "Oyun Alanı", "KAT_1", "kids_area", 70),
        ZoneBlueprint("B_SERVICE", "Teknik Servis", "KAT_1", "service", 25),
    ),
    stores=(
        StoreBlueprint("Mango", "moda", "B_RETAIL_1"),
        StoreBlueprint("Defacto", "moda", "B_RETAIL_1"),
        StoreBlueprint("Simit Sarayı", "yemek", "B_FOODCOURT"),
        StoreBlueprint("Pizza Pizza", "yemek", "B_FOODCOURT"),
        StoreBlueprint("Gloria Jean's", "kahve", "B_FOODCOURT"),
    ),
)


MALL_BLUEPRINTS: tuple[MallBlueprint, ...] = (MALL_A, MALL_B)
