"""Kural tabanlı sentetik yoğunluk üreticisi.

Gerçek sensör verisi olmadığı için crowd_readings tablosunu, saat/gün/hava/etkinlik
etkilerini formüllerle simüle eden bu modül besler. Hem toplu geçmiş veri üretimi
(generate_historical.py) hem de canlı simülasyon (simulation.py) burayı kullanır.
"""

import random
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .mall_config import MallConfig

# Faz 7.109: paylaşılan (global) `random` modülü yerine bu modüle ÖZEL bir RNG
# örneği — bkz. `seed_rng_for()`. Kök sebep: canlı simülasyon çalışırken sunucuya
# gelen eşzamanlı HTTP istekleri (FastAPI'nin senkron endpoint'leri ayrı
# thread'lerde çalışıyor) global `random` durumuna bir şekilde karışabiliyordu;
# iki izole sunucu HİÇBİR dış trafik almadan çalıştırıldığında (sıfır curl/WS)
# sonuçlar birebir aynı çıktı (enjekte anomali sayısı dahil, 23=23), ama gerçek
# uygulamada (curl/tarayıcı bağlantısı varken) restart'lar arası hâlâ küçük
# farklar oluyordu — bu da paylaşılan global RNG'nin process içindeki BAŞKA bir
# şeyle (hangi mekanizmayla olduğu tam tespit edilemedi) paylaşıldığını
# gösteriyordu. Kendi özel `rng` nesnemiz olunca, dışarıdan hiçbir şey (hangi
# thread/kütüphane olursa olsun) bu akışa asla karışamaz — kök sebebi tek tek
# bulmaya gerek kalmadan sorunu yapısal olarak kapatıyor.
#
# Faz 8.3: TEK paylaşılan `rng` nesnesi yerine, AVM başına AYRI bir RNG —
# kullanıcı fark etti: çoklu AVM desteğinde (Faz 8.1) tüm AVM'ler AYNI `rng`
# akışını SIRAYLA paylaşıyordu, yani Mall B'nin eğitimi Mall A'nın CANLI
# simülasyonu başlamadan ÖNCE araya girip akışı kaydırıyordu — Mall A'nın
# kendi ayarları hiç değişmediği halde sadece Mall B eklendiği için Mall A'nın
# sonuçları (hangi anomalilerin ne zaman enjekte edildiği) değişiyordu. Artık
# her AVM `rng_for(mall_id)` ile KENDİ bağımsız RNG'sini alıyor — bir AVM
# eklemek/çıkarmak/sırasını değiştirmek DİĞER AVM'lerin sonuçlarını asla
# etkilemiyor, her AVM kendi başına tam deterministik.
_rngs: dict[int, random.Random] = {}


def rng_for(mall_id: int) -> random.Random:
    return _rngs.setdefault(mall_id, random.Random())


def seed_rng_for(mall_id: int, seed: int) -> None:
    rng_for(mall_id).seed(seed)


# Faz 7.106: tüm sentetik zaman çizelgesinin (geçmiş veri + canlı simülasyon)
# çapalandığı SABİT referans an. Önceden `generate_historical.py` ve
# `simulation.py` `datetime.now()` (GERÇEK duvar saati) kullanıyordu — seed
# (Faz 7.17) veri ÜRETİMİNİ deterministik yapıyordu ama üretilen verinin HANGİ
# takvim gününe/haftanın gününe denk geldiği hâlâ "uygulama ne zaman açıldı"ya
# bağlıydı; bu da restart'lar arası farklı gün/saat eşleşmesi → farklı sonuç
# demekti. Artık HER ŞEY bu sabit ana göre
# — restart'lar arası tam, birebir aynı sonuç garantisi bu sayede sağlanıyor.
REFERENCE_NOW = datetime(2025, 1, 1)

# Faz 7.117: kullanıcının belirttiği gerçek AVM saatleriyle (09:00 açılış,
# 22:00 kapanış) tutarlı olacak şekilde düzeltildi. Önceden saat 22'nin tabanı
# %35, saat 23'ün %12'ydi — bunlar "kapanmış" bir AVM'yi yansıtmıyordu, hâlâ
# günün ortası kadar yoğundu. Kapanıştan (22:00) hemen sonra küçük bir
# "temizlik/güvenlik" izi (22/23), açılıştan ÖNCE 2 saatlik bir hazırlık
# penceresi (07/08), gece yarısının ortasında (00-06) ise TAM SIFIR —
# gerçekte de o saatlerde muhtemelen kimse yok. Bu, anomali tespitindeki
# "kapanış saati" iş kuralının (bkz. anomaly.py CLOSED_HOURS) veriyle tutarlı
# çalışmasını sağlıyor — 22:00-08:59'un TAMAMI artık gerçekten sessiz/boş.
# DENEME (Faz 7.118, GERİ ALINDI): canlı testte 51 yanlış alarmın 18'i (14+4)
# tam saat 22/23'ten geliyordu — %5/%2'lik iz + doğal gürültü bazen %8
# eşiğini aşıyordu. İz küçültüldü (%5→%3, %2→%1) — hedeflenen saatlerde
# gerçekten işe yaradı (18→12) AMA beklenmedik bir yan etki çıktı: model her
# zone için eğitim verisinin TAMAMINA göre TEK bir bütün olarak eğitiliyor,
# saat 22/23'ün eğitim verisini değiştirmek modelin AÇIK saatler (15-21) için
# öğrendiği "normal" sınırını da dolaylı kaydırdı — o saatlerdeki yanlış alarm
# 33'ten 47'ye çıktı. NET SONUÇ KÖTÜLEŞTİ (51→59) — GERİ ALINDI, eski
# değerlere (%5/%2) dönüldü. Ders: eğitim verisinin bir kısmını değiştirmek,
# modelin GÖRÜNÜŞTE ilgisiz diğer kısımlardaki davranışını da etkileyebiliyor
# (paylaşılan/bütünsel model — saat başına ayrı model değil).
#
# Faz 8.1: çoklu AVM desteğiyle bu artık TEK global sabit değil — "Mall A"nın
# (ilk/mevcut AVM) kendi doluluk eğrisi olarak MALL_A_HOURLY_CURVE adını aldı,
# değeri AYNEN korundu (yukarıdaki tüm ayar geçmişi hâlâ geçerli). Yeni
# AVM'ler `generate_hourly_curve()` ile kendi açılış/kapanış saatlerine göre
# bu ŞEKLİ yeniden kullanıyor (aşağıda) — sıfırdan sihirli sayılar uydurmak
# yerine, onlarca turluk kanıtlanmış deseni yeniden ölçekliyor.
MALL_A_HOURLY_CURVE = [
    0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.02,  # 00-07
    0.05, 0.10, 0.18, 0.28, 0.45, 0.42, 0.30, 0.28,  # 08-15
    0.32, 0.40, 0.52, 0.65, 0.70, 0.55, 0.05, 0.02,  # 16-23
]

# Mall A'nın AÇIK saatlerindeki (09:00-22:00, saat 9..21) ham eğri şekli —
# generate_hourly_curve()'ün yeni bir açılış/kapanış penceresine enterpole
# ettiği referans desen.
_MALL_A_OPEN_SHAPE = MALL_A_HOURLY_CURVE[9:22]


def generate_hourly_curve(opening_hour: int, closing_hour: int) -> list[float]:
    """Mall A'nın kanıtlanmış açık-saat eğri ŞEKLİNİ (Faz 7.117/7.118'in
    onlarca turluk ayarı) yeni bir açılış/kapanış penceresine enterpole eder.
    `generate_hourly_curve(9, 22)` MALL_A_HOURLY_CURVE ile BİREBİR aynı
    sonucu üretir (doğrulandı) — bu da enterpolasyonun doğru çalıştığının
    kanıtı. Açılıştan önce 2 saatlik hazırlık izi, kapanıştan sonra 2 saatlik
    temizlik izi (Mall A'nın 07/08 ve 22/23 değerleriyle aynı), aradaki gece
    saatleri tam sıfır."""
    open_duration = closing_hour - opening_hour
    curve = [0.0] * 24
    src = _MALL_A_OPEN_SHAPE
    src_len = len(src)
    for i in range(open_duration):
        src_pos = i / max(1, open_duration - 1) * (src_len - 1) if open_duration > 1 else 0
        lo = int(src_pos)
        hi = min(lo + 1, src_len - 1)
        frac = src_pos - lo
        curve[(opening_hour + i) % 24] = src[lo] + (src[hi] - src[lo]) * frac
    curve[(opening_hour - 1) % 24] = MALL_A_HOURLY_CURVE[8]  # açılıştan 1 saat önce: hazırlık
    curve[(opening_hour - 2) % 24] = MALL_A_HOURLY_CURVE[7]  # açılıştan 2 saat önce: hafif iz
    curve[closing_hour % 24] = MALL_A_HOURLY_CURVE[22]  # kapanış anı: temizlik geçişi
    curve[(closing_hour + 1) % 24] = MALL_A_HOURLY_CURVE[23]  # kapanıştan 1 saat sonra: hafif iz
    return curve

# Zone tipine göre eğrinin ne kadar öne çıkacağı (kendi başına yoğunluk potansiyeli)
ZONE_TYPE_PEAK_FACTOR = {
    "entrance": 1.0,
    "retail": 0.85,
    "food_court": 1.1,
    "cinema": 0.55,  # cinema trafiği asıl seans (event) etkisinden gelir
    "parking": 1.0,
    "walkway": 0.5,
    "kids_area": 0.9,
    "service": 0.25,
    "info_desk": 0.4,
    "entertainment": 0.9,
}

# Kapasitesi tanımsız zone'lar için (Ana Giriş, Yürüyen Merdiven vb.) ölçek referansı
DEFAULT_SCALE_NO_CAPACITY = 180

# Faz 8.1: WEEKEND_WEEKDAYS/WEEKEND_MULTIPLIER artık AVM'ye özel — bkz.
# mall_config.MallConfig. Mall A'nın değerleri (Pazartesi=0...Cuma=4,
# Cumartesi=5, Pazar=6 → {4,5,6}, çarpan 1.25) mall_blueprints.py'de yaşıyor.

# Faz 7.93: aralık %95-%110'dan (spread 0.15) %85-%125'e (spread 0.40)
# genişletildi. Sebep: kısa-vadeli model (`features.py`) BUGÜNÜN GERÇEK hava
# durumunu bir özellik olarak biliyor (15-60dk'da hava değişmez), trend/LSTM
# ise SADECE geçmiş 4 haftanın doluluğuna bakıyor — gelecek haftanın havasını
# asla bilemez (tasarım gereği, bkz. trend.py). Eski dar aralıkta bu gerçek
# metodolojik fark (biri hava bilir, biri bilmez) `/models` sayfasında hiç
# görünmüyordu — ikisi de aynı ~%95'e çıkıyordu çünkü hava etkisi LSTM'in 4
# haftalık ortalamasında zaten sönümleniyordu. Daha geniş aralık bu farkı
# ölçülebilir kılıyor.
WEATHER_MULTIPLIER = {
    "gunesli": 0.85,
    "bulutlu": 1.0,
    "yagmurlu": 1.25,
    "karli": 1.1,
}

WEATHER_CHOICES = ["gunesli", "gunesli", "bulutlu", "bulutlu", "yagmurlu", "karli"]

CINEMA_SESSION_HOURS = [14, 17, 19.5, 21.5]


def random_weather(rng: random.Random) -> str:
    return rng.choice(WEATHER_CHOICES)


def event_boost_for_cinema(dt: datetime, sessions_today: list[float]) -> float:
    """Bir sinema seansına yakınsa (başlamadan 15 dk önce - başladıktan 90 dk sonra) ek yoğunluk."""
    hour_frac = dt.hour + dt.minute / 60
    for session_hour in sessions_today:
        if session_hour - 0.25 <= hour_frac <= session_hour + 1.5:
            return 0.4
    return 0.0


def _interpolated_curve_value(dt: datetime, hourly_curve: "tuple[float, ...] | list[float]") -> float:
    """Saat başı değerler arasında düz çizgiyle geçiş yapar; aksi halde her saatin
    ilk 45 dakikası birebir aynı değeri üretip yapay/sabit görünürdü."""
    hour = dt.hour
    next_hour = (hour + 1) % 24
    frac_within_hour = dt.minute / 60
    return hourly_curve[hour] + (hourly_curve[next_hour] - hourly_curve[hour]) * frac_within_hour


# Faz 8.21: kullanıcı fark etti — kapalı saatlerde (`base` eğrisi ~0) bile
# gürültü HER ZAMAN sabit %5 std'ydi, bu da rastgele (enjekte anomali
# OLMAYAN) okumaların bile sık sık `closed_hour_anomaly_threshold_pct`'i
# (%8) aşıp "yanlış alarm" üretmesine yol açıyordu — ölçüldü: TÜM yanlış
# alarmların %62.8'i (472/752) kapalı saatlerdeydi. Kök neden modelde ya da
# eşikte değil, veride: `base` düşükken bile gürültü büyüklüğü hiç
# küçülmüyordu. `_NOISE_STD_FLOOR`/`_NOISE_SCALE_BASE_THRESHOLD` ile gürültü
# artık `base`'e göre ölçekleniyor — AÇIK saatlerde (`base>=0.1`) DAVRANIŞ
# BİREBİR AYNI (std=0.05, hiç değişmedi), sadece kapalı/geçiş saatlerinde
# küçülüyor.
#
# DENEME (Faz 8.25): kalan yanlış alarmların hava durumuna göre çarpık
# olduğu ölçüldü (güneşli günlerde aşırı temsil, yağmurlu günlerde sıfır) —
# gürültü ölçekleme referansını `base * weather_mult`'a genişletmek denendi.
# TAM BİTEN canlı hafta sonucu: net kazanç YOK (yakalama %78.9→%76.3 DÜŞTÜ,
# yanlış alarm %5.35→%5.28 — istatistiksel gürültü seviyesinde, anlamsız) VE
# hava dağılımı çarpıklığı neredeyse hiç düzelmedi (güneşli hâlâ %51.3 aşırı
# temsilli). Sebep: `_NOISE_SCALE_BASE_THRESHOLD=0.1` eşiği açık saatlerin
# çoğunda zaten aşılıyor (`base` tipik 0.18-0.70), weather_mult=0.85 ile
# çarpılsa bile çoğu zaman eşiğin altına düşmüyor — düzeltme pratikte nadiren
# devreye giriyordu. GERİ ALINDI.
_NOISE_STD_OPEN = 0.05
_NOISE_STD_FLOOR = 0.01
_NOISE_SCALE_BASE_THRESHOLD = 0.1


def occupancy_fraction(
    zone_type: str,
    dt: datetime,
    weather_condition: str,
    config: "MallConfig",
    rng: random.Random,
    event_boost: float = 0.0,
) -> float:
    base = _interpolated_curve_value(dt, config.hourly_curve)
    peak_factor = ZONE_TYPE_PEAK_FACTOR.get(zone_type, 0.8)
    weekend_mult = config.weekend_multiplier if dt.weekday() in config.weekend_weekdays else 1.0
    weather_mult = WEATHER_MULTIPLIER.get(weather_condition, 1.0)

    fraction = base * peak_factor * weekend_mult * weather_mult + event_boost
    noise_std = max(_NOISE_STD_FLOOR, _NOISE_STD_OPEN * min(1.0, base / _NOISE_SCALE_BASE_THRESHOLD))
    noise = rng.gauss(0, noise_std)
    return max(0.0, min(1.15, fraction + noise))


def generate_reading(
    *,
    zone_type: str,
    capacity: int | None,
    dt: datetime,
    weather_condition: str,
    prev_count: int,
    config: "MallConfig",
    rng: random.Random,
    event_boost: float = 0.0,
) -> tuple[int, int, int]:
    """Bir zone için (person_count, entries, exits) üretir."""
    fraction = occupancy_fraction(zone_type, dt, weather_condition, config, rng, event_boost)
    scale = capacity if capacity else DEFAULT_SCALE_NO_CAPACITY
    person_count = max(0, round(fraction * scale))

    net_change = person_count - prev_count
    churn_base = max(4, round(0.08 * scale))
    noise_entries = rng.randint(0, 4)
    noise_exits = rng.randint(0, 4)

    entries = max(0, net_change) + churn_base // 2 + noise_entries
    exits = max(0, -net_change) + churn_base // 2 + noise_exits

    return person_count, entries, exits


# --- Anomali enjeksiyonu -----------------------------------------------------
# SADECE simulation.py (canlı) kullanır — generate_historical.py (Faz 3 tahmin
# modelinin eğitim verisi) bilinçli olarak KULLANMAZ. Isolation Forest zaten
# "normalin dışında kalan azınlık" mantığıyla çalıştığı için eğitim verisinin
# anomali İÇERMESİNE ihtiyacı yok; buradaki enjeksiyon sadece demo/test amaçlı
# canlı sistemde ara sıra gerçek bir anomali görünsün diyedir.

# Faz 7.92: 0.001 (%0.1) idi — matematiği hiç çıkarılmamıştı. Canlı simülasyon
# TOPLAM ~11 gerçek dakika sürüyor (7 sim gün, 900x hız, bkz. simulation.py
# MAX_LIVE_SIMULATION_DAYS) ve kendiliğinden duruyor; o pencerede 14 zone × 672
# tick = 9408 kontrol var. %0.1 ile beklenen bilinen-anomali sayısı ~9 —
# `/models` sayfasındaki "kaç gerçek anomali yakalandı" metriğinin güvenilir
# (örneklem yeterli) sayılabilmesi için pratikte HİÇBİR ZAMAN yeterli olmuyordu.
# %0.5'e çıkarılınca beklenen sayı ~47'ye çıkıyor — tek bir simülasyon koşusunda
# güvenilir bir örneklem birikebiliyor, hâlâ "nadir" (okumaların sadece %0.5'i).
ANOMALY_PROBABILITY = 0.005
ANOMALY_MULTIPLIER_RANGE = (2.5, 4.0)

# Faz 8.15: kullanıcı fark etti — AVM'ler için "az kişi" de "çok kişi" kadar
# gerçek bir kaygı (ciro kaybı, bir olay/kapanış işareti vb.), sadece
# güvenlik/kapasite riski değil. Eskiden enjeksiyon HER ZAMAN bir sıçramaydı
# (artış); şimdi %50 ihtimalle artış, %50 ihtimalle azalış oluyor — bu da
# Faz 8.7'deki bildirim `direction`'ının ("düşük" tarafının) canlı sistemde
# GERÇEK ground-truth'la doğrulanabilmesini sağlıyor (öncesinde "düşük" yönü
# hiç enjekte edilmiş bir anomaliyle eşleşmiyordu).
ANOMALY_DIRECTION_UP_PROBABILITY = 0.5
ANOMALY_DROP_MULTIPLIER_RANGE = (0.05, 0.35)


# Faz 7.114: taban `person_count` zaten 0/çok düşükse (gece saatleri), çarpımsal
# enjeksiyon (`person_count * multiplier`) da 0/çok düşük kalıp GÖZLEMLENEBİLİR
# HİÇBİR İZ bırakmıyordu — `is_injected_anomaly=True` diye etiketleniyordu ama
# okuma normal bir gece okumasından birebir aynıydı (0×4=0). Bu, anomali
# modelinin bir "kaçırma"sı değildi — ground truth'un kendisi kusurluydu, hiçbir
# dedektör gözlemlenemeyen bir farkı yakalayamaz (bkz. docs/ROADMAP.md Faz 7.114, canlı
# `/anomalies/events`'teki 9 false-negative'in hepsi düşük/sıfır doluluktaydı,
# 4'ü tam %0.0). Minimum bir taban (kapasitenin %10'u) garantiliyoruz — az kişi
# olsa bile "birden kalabalıklaştı" senaryosu hâlâ gerçekçi ve artık gerçekten
# gözlemlenebilir.
ANOMALY_MIN_FLOOR_FRACTION = 0.10

# DENEME (Faz 8.28): Faz 8.15'in "azalış tarafı bilinçli düzeltilmiyor" kararı
# yeniden gözden geçiriliyor — canlı ölçümde kaçırılan (false negative) 8
# anomalinin 6'sının gözlenen kişi sayısı 0 veya 1 çıktı: taban zaten çok
# düşükken (gece) enjekte edilen azalış, o saatin DOĞAL gürültüsünden
# istatistiksel olarak ayırt edilemiyor — Faz 7.114'ün artış tarafında
# bulduğu "gözlemlenemeyen ground-truth" sorununun azalış versiyonu. Taban
# zaten bu eşiğin altındaysa yön ARTIŞ'a zorlanıyor (azalış enjekte
# edilmiyor) — artış tarafının zaten garantili gözlemlenebilirliği var.
ANOMALY_QUIET_BASELINE_FRACTION = 0.15

# "Gözlenebilir anomali" kuralı: Faz 7.114/8.28'in eksik kalan parçası.
# `ANOMALY_MIN_FLOOR_FRACTION` MUTLAK bir taban (kapasitenin %10'u) — taban
# zaten %5-8 iken bu sadece +2-5 puanlık, gürültüyle aynı büyüklükte bir
# "sıçrama" demek; küçük zone'larda (Danışma=20) 1-2 kişi. Bunlar hâlâ
# `is_injected_anomaly=True` etiketiyle ölçüme giriyordu (canlı haftada TFT'nin
# kaçırdıklarının neredeyse tamamı). Artık her enjeksiyon ÖNCEKİ değerden en az
# max(5 kişi, kapasitenin %10'u) kadar FARK yaratıyor. Anomali sayısı/zamanı
# DEĞİŞMİYOR (ek rastgele sayı çekilmiyor), zaten büyük olanlar aynen kalıyor.
# 3 yeni haftada (DB kopyasında) ölçüldü: TFT F1 Mall A %92.1→%94.4, Mall B
# %82.6→%94.8, yanlış alarm aynı (12 / 7).
ANOMALY_MIN_CHANGE_PEOPLE = 5
ANOMALY_MIN_CHANGE_FRACTION = 0.10


def maybe_inject_anomaly(person_count: int, scale: float, rng: random.Random) -> tuple[int, bool]:
    if rng.random() >= ANOMALY_PROBABILITY:
        return person_count, False
    direction_up = rng.random() < ANOMALY_DIRECTION_UP_PROBABILITY
    if not direction_up and person_count < ANOMALY_QUIET_BASELINE_FRACTION * scale:
        direction_up = True
    min_change = max(ANOMALY_MIN_CHANGE_PEOPLE, round(ANOMALY_MIN_CHANGE_FRACTION * scale))
    if direction_up:
        multiplier = rng.uniform(*ANOMALY_MULTIPLIER_RANGE)
        min_floor = round(ANOMALY_MIN_FLOOR_FRACTION * scale)
        spiked = min(max(round(person_count * multiplier), min_floor), round(scale * 2.5))
        return max(spiked, person_count + min_change), True
    multiplier = rng.uniform(*ANOMALY_DROP_MULTIPLIER_RANGE)
    dropped = min(max(0, round(person_count * multiplier)), person_count - min_change)
    if dropped < 0:  # yeterince düşürülemiyor → artışa çevir
        return person_count + min_change, True
    return dropped, True
