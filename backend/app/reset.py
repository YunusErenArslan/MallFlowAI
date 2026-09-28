"""Backend her başladığında tüm state'i (DB + eğitilmiş modeller) baştan
üretir — tasarım kararı: canlı doğruluk sayaçlarının restart'lar arası
kalıcı birikmesindense, her başlangıçta sabit/tekrarlanabilir bir "ilk gün"
durumundan başlamak tercih edildi (bkz. docs/ROADMAP.md Faz 7.14). Bunun doğal
sonucu: canlı doğruluk (`model_metrics.unified_accuracy`) hiçbir zaman n≥20
eşiğini geçemez — backend sürekli açık kalmadıkça (haftalarca) "-" gösterir.

DÜRÜSTLÜK NOTU (Faz 7.17): "ilk hale dönsün" hiçbir yerde seed sabitlenmediği
için gerçekte HER restart'ta FARKLI bir "ilk hal" üretiyordu — hem sentetik
veri (`synthetic.py`'nin `random` çağrıları) hem LSTM eğitimi (PyTorch'un
ağırlık başlangıcı + veri karıştırma sırası) seedsizdi. Ölçüldü: iki ardışık
reset'te trend MAE'si 6.85 vs 6.08 puan çıktı — aynı kod, farklı sonuç.
`random.seed`/`torch.manual_seed` burada, reset'in en başında sabitlenerek
düzeltildi — artık her restart GERÇEKTEN aynı veriyi, aynı model sonuçlarını
üretiyor. Yan etki: bu seed canlı simülasyonun da (reset sonrası başlayan)
rastgelelik akışını belirliyor — yani hava durumu örüntüsü, enjekte edilen
anomalilerin ZAMANLAMASI da her restart'ta birebir aynı olacak. Bu, "her
başlangıç aynı ilk gün" kararıyla (Faz 7.14) tutarlı kabul edildi.

DÜRÜSTLÜK NOTU (Faz 7.20): Trend tahminleri önceden zone başına, kullanıcı
`/trend` sayfasını o zone için ilk açtığı ANDA (on-demand) üretiliyordu —
gerçek sistemlerde bu böyle olmaz, tahminler zamanlanmış bir toplu işle (batch
job) TÜM zone'lar için AYNI ANDA üretilir. On-demand yol, farklı zone'ların
tahmin pencerelerinin farklı referans zamanlara çapalanmasına (senkronsuzluğa)
yol açıyordu. Düzeltildi: reset'in sonunda, tüm zone'lar için TEK SEFERDE
(aynı referans zamana göre) haftalık tahmin üretilip kaydediliyor — gerçek
sistemlerdeki zamanlanmış toplu iş mantığıyla tutarlı. `get_forecast_with_actuals`
artık kendi başına yeni tahmin ÜRETMİYOR (bkz. trend.py), sadece burada
üretilmiş senkron seriyi okuyor.

DÜRÜSTLÜK NOTU (Faz 8.1): Çoklu AVM desteğiyle bu fonksiyon artık
`MALL_BLUEPRINTS`'teki TÜM AVM'leri SIRAYLA kuruyor (seed → geçmiş veri →
3 model eğitimi → haftalık tahmin), tek bir AVM değil.

DÜRÜSTLÜK NOTU (Faz 8.3): Faz 8.1'de paylaşılan `synthetic.rng`/torch RNG
durumu AVM'ler arası DEVAM EDİYORDU (yeniden sıfırlanmıyordu) — yani bir AVM
eklemek/çıkarmak/sırasını değiştirmek DİĞER AVM'lerin (ör. Mall A'nın) kendi
sayılarını da değiştiriyordu. Kök neden: Python'un `random.Random` ve
PyTorch'un global üreteci PROCESS seviyesinde TEK bir akıştı, bir AVM'nin
eğitimi sırasında tüketilen her rastgele sayı bir SONRAKİ AVM'nin akışının
nereden başlayacağını kaydırıyordu. Düzeltme: her AVM artık `synthetic.rng_for(mall.id)`
ile KENDİ bağımsız Python RNG'sini alıyor (aşağıda `seed_rng_for` ile
AVM başına ayrı seedleniyor), ve `trend.train()` çağrılmadan hemen önce
`torch.manual_seed()` AVM'ye özel bir değerle YENİDEN çağrılıyor (PyTorch'un
global üreteci mall-bazında paylaşılamayacağı için — sklearn'ün
`random_state=42` parametresi zaten instance-scoped olduğundan bu sorundan
muaf, değişiklik gerekmedi). Sonuç: `MALL_BLUEPRINTS`'in sırası/içeriği artık
HİÇBİR AVM'nin sonucunu etkilemiyor, her AVM tamamen kendi başına
deterministik. (Sıra artık önemsiz olsa da, okunabilirlik için blueprint'ler
yine de sabit sırada tutuluyor.)"""

import torch

from . import anomaly_tft, models, predict, trend
from .database import Base, SessionLocal, engine
from .generate_historical import generate as generate_historical_data
from .generate_live_week import generate_live_week
from .mall_blueprints import MALL_BLUEPRINTS
from .retention import TRAINING_WINDOW_DAYS
from .seed_stores import seed_mall_stores
from .seed_zones import seed_mall_zones
from .synthetic import seed_rng_for
from .train_model import train as train_short_term_models

RESET_SEED = 42


def reset_to_initial_state() -> None:
    # Faz 7.108: `app/__init__.py`'daki *_NUM_THREADS=1 ortam değişkenleri BLAS
    # katmanını (numpy/sklearn) tek thread'e zorluyor; torch'un KENDİ iç thread
    # havuzu ayrı bir ayar, o da burada aynı şekilde sabitleniyor — ikisi
    # olmadan (seed tek başına) matris/histogram toplama sırası çoklu thread'de
    # her restart'ta mikroskobik farklı olup modelin ağırlıklarını
    # etkileyebiliyordu (bkz. docs/ROADMAP.md Faz 7.106/7.107).
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)

    # Kaldırılan IsolationForest'ın tablosu artık modellerde tanımlı değil, yani
    # `drop_all` onu bilmiyor — ama `zones`'a FOREIGN KEY'i olduğu için önce
    # silinmezse `DROP TABLE zones` başarısız olur (eski veritabanlarında).
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS anomaly_detections")
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    # 1) TÜM AVM'leri seed et — SABİT sırayla (bkz. yukarıdaki DÜRÜSTLÜK NOTU).
    db = SessionLocal()
    try:
        for blueprint in MALL_BLUEPRINTS:
            mall = seed_mall_zones(db, blueprint)
            seed_mall_stores(db, mall, blueprint)
    finally:
        db.close()

    # 2) Her AVM için: geçmiş veri üret → 3 modeli eğit → haftalık tahmin.
    # AYNI sabit sırayla (MALL_BLUEPRINTS listesi) — yeniden sorgulamıyoruz,
    # sıra garantisi için doğrudan blueprint sırasına göre AVM'yi buluyoruz.
    db = SessionLocal()
    try:
        malls_by_slug = {m.slug: m for m in db.query(models.Mall).order_by(models.Mall.id).all()}
    finally:
        db.close()

    for blueprint in MALL_BLUEPRINTS:
        mall = malls_by_slug[blueprint.slug]
        # Faz 8.3: AVM başına BAĞIMSIZ seed — bkz. modül docstring'indeki
        # DÜRÜSTLÜK NOTU. `mall.id` seed'e katılıyor ki AVM'ler birbirinin
        # BİREBİR aynı akışını paylaşmasın (Mall A ile Mall B farklı diziler
        # üretsin), ama her AVM'nin kendi akışı restart'lar arası sabit kalsın.
        seed_rng_for(mall.id, RESET_SEED + mall.id)
        generate_historical_data(mall, days=TRAINING_WINDOW_DAYS, force=True)
        train_short_term_models(mall)
        # Faz 8.11: canlı 7 günlük haftanın TAMAMI burada, TOPLU olarak
        # önceden üretilip `staged_crowd_readings`/`staged_weather_readings`e
        # yazılıyor — `simulation.py`'nin canlı döngüsü artık üretmiyor,
        # zaman geldikçe buradan "açığa çıkarıyor" (kopyalıyor). Bu çağrının
        # KONUMU kritik: `rng_for(mall.id)` akışında canlı simülasyonun
        # BUGÜN tam olarak tüketmeye başladığı nokta burası (geçmiş veri
        # üretimi SONRASI) — başka bir yere taşınırsa akış
        # kayar, sonuçlar (ve restart-arası/AVM'ler-arası determinizm
        # garantileri) bugünkünden sapar.
        generate_live_week(mall)
        # PyTorch'un üreteci global olduğu için (bkz. DÜRÜSTLÜK NOTU) her AVM'nin
        # LSTM eğitimi öncesi YENİDEN sabitleniyor — bir önceki AVM'nin eğitimi
        # ne kadar rastgele sayı tüketmiş olursa olsun bu AVM her zaman aynı
        # başlangıç durumundan başlar.
        torch.manual_seed(RESET_SEED + mall.id)
        trend.train(engine, mall)

        # Tüm zone'lar için AYNI ANDA (aynı referans zamana göre) haftalık
        # tahmin üret — gerçek sistemlerdeki zamanlanmış toplu iş (batch job)
        # mantığı, zone'ların tahmin pencereleri arasında senkronsuzluğu önler.
        db = SessionLocal()
        try:
            for zone in db.query(models.Zone).filter(models.Zone.mall_id == mall.id).order_by(models.Zone.id).all():
                trend.forecast_next_week(db, zone, mall.id)
        finally:
            db.close()

        # TFT anomali modeli: kayıtlı model geçerliyse yeniden kullanılır, değilse
        # eğitilir (bkz. `anomaly_tft.ensure_trained`). `rng_for(mall.id)` akışına
        # dokunmuyor. NOT: kaldırılan IsolationForest'ın eğitimi bu akıştan ek
        # sentetik geçmiş çekiyordu — onun kalkmasıyla canlı hafta bugünkünden
        # FARKLI (ama yine sabit/tekrarlanabilir) bir hafta oldu.
        anomaly_tft.ensure_trained(engine, mall)

    predict.clear_model_cache()


def get_all_malls() -> list["models.Mall"]:
    """`main.py`'nin lifespan başlangıcında her AVM için ayrı bir simülasyon
    görevi (`simulation.start(mall.id)`) başlatabilmesi için."""
    db = SessionLocal()
    try:
        return db.query(models.Mall).order_by(models.Mall.id).all()
    finally:
        db.close()
