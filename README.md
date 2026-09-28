# MallFlow AI

AVM içi ziyaretçi yoğunluğunu **izleyen, tahmin eden ve olağandışı durumları yakalayan** yapay zekâ destekli bir uygulama.
Bölge bazında canlı doluluk, 15–60 dakika ve 1 hafta ilerisi için tahmin, TFT tabanlı anomali tespiti,
bildirim sistemi, haftalık raporlar ve 2D/3D kat planları içerir.

> Tüm veri **sentetiktir**. Gerçek sensör verisi yerine saat, gün, hafta sonu, hava durumu, etkinlik ve
> sinema seanslarını modelleyen kural tabanlı bir simülatör kullanılır. Kapasiteler, mağazalar ve AVM'ler
> de örnek amaçlıdır.

## Özellikler

- **Dashboard** — anlık ziyaretçi sayısı ve doluluk, saatlik değişim, en yoğun kat ve bölge,
  gün boyu AVM doluluk grafiği (gerçekleşen + gün sonuna kadar tahmin, yüzde ve kişi sayısı),
  kat ve bölge bazında yoğunluk.
- **Canlı Harita** — kat planı üzerinde bölge bazında canlı doluluk (2D).
- **3D Görünüm** — AVM binası ve otoparkın 3D modeli; bölgeye tıklayınca yakınlaşır.
- **Kısa Vadeli Tahminler** — her bölge için 15 / 30 / 45 / 60 dakika sonrası doluluk, risk seviyesi ve öneri.
- **Uzun Vadeli Tahminler** — bir hafta ilerisi için saatlik trend tahmini; zaman geçtikçe gerçekleşenle karşılaştırılır.
- **Otopark** — P1/P2/P3 doluluk ve yönlendirme önerisi (MallFlow AVM).
- **Anomaliler** — beklenmedik ziyaretçi artışı/azalışı olayları; modelin beklediği aralık ile gerçekleşen değer.
- **Bildirimler** — kapasite (yüksek/kritik yoğunluk) ve anomali uyarıları; zil, toast ve filtrelenebilir bildirim sayfası.
- **Raporlar** — bu hafta ile geçen haftanın karşılaştırması: günlük grafik, gün × saat ısı haritası,
  kat ve bölge tabloları. Canlı akışla birlikte güncellenir.
- **Mağazalar** — bölgelere göre gruplanmış mağaza arama.
- **Model Doğruluğu** — üç modelin canlı veri üzerindeki başarısı.
- **Çoklu AVM** — iki örnek AVM (`mall-a`: MallFlow AVM, `mall-b`: Şehir Plaza); her biri kendi verisi ve modelleriyle.

## Mimari

```
apps/web     Next.js 16 (App Router) + Tailwind + Recharts + React Three Fiber
backend      FastAPI + SQLAlchemy + SQLite + PyTorch + scikit-learn
```

- **Canlı akış:** Backend bir simülasyon saati yürütür (varsayılan 900× hız: 15 simüle dakika ≈ 1 gerçek saniye).
  Her adımda bölge okumaları veritabanına yazılır, anomali modeli çalıştırılır ve doluluk, tahmin, uyarı ve
  otopark durumu tek bir WebSocket mesajıyla (`/malls/{slug}/ws/live`) arayüze gönderilir. Tüm sayfalar bu
  tek bağlantıyı paylaşır. 30 günlük geçmişin ardından 7 günlük canlı hafta oynatılır ve simülasyon durur.
- **Her açılış aynı başlangıç:** Backend her başladığında veritabanını sıfırlar, 30 günlük geçmiş veri üretir,
  kısa vadeli ve trend modellerini eğitir. Rastgelelik sabit seed'lerle kontrol edildiği için her açılış
  aynı veriyi ve aynı sonuçları üretir.
- **Doluluk ölçeği:** Doluluk = kişi sayısı ÷ bölge kapasitesi. Kapasitesi tanımsız bölgeler (giriş, yürüyen
  merdiven) için 180 kişilik referans ölçek kullanılır. AVM geneli, tüm bölgelerin toplamına göre hesaplanır.

## Modeller

| Model | Amaç | Yöntem |
|---|---|---|
| Kısa vadeli tahmin | 15/30/45/60 dk sonraki doluluk | Ufuk başına ayrı `HistGradientBoostingRegressor` (saat, gün, gecikmeli değerler, giriş/çıkış, hava, etkinlik) |
| Trend tahmini | 1 hafta ilerisi, saatlik | PyTorch LSTM; girdi olarak aynı saatin 7/14/21/28 gün önceki değerleri, tüm bölgeler tek modelde |
| Anomali tespiti | Beklenmedik artış/azalış | Temporal Fusion Transformer (TFT), sonraki 15 dakika için kantil tahmini (q01–q99) |

**Kısa vadeli tahmin:** Her ufuk (15/30/45/60 dk) için ayrı bir gradient boosting modeli, bölgenin
şu anki ve 15/30/45/60 dk önceki kişi sayısından, giriş−çıkış sayaçlarından, saat/gün/hafta sonu, hava, etkinlik
ve bölge bilgisinden gelecekteki kişi sayısını tahmin eder; bu sayı bölge ölçeğine göre doluluk yüzdesine
çevrilir. Tahmin edilen doluluktan kural tabanlı bir risk seviyesi ve operasyon önerisi üretilir. Veri
kronolojik bölünür (son %20 test). Tahminler kaydedilir ve hedef zaman gelince gerçekleşenle karşılaştırılır.

**Trend tahmini (LSTM):** Her saat için aynı saatin 7, 14, 21 ve 28 gün önceki doluluğu 4 adımlı bir dizi
olarak LSTM'e verilir; bölge türü bir embedding ile eklenir ve tüm bölgeler tek bir modelde eğitilir. Model
her saati, geçmiş 4 haftanın aynı gün ve saatindeki gerçek değerlere bakarak tahmin eder; kendi tahminlerini
girdi olarak kullanmadığı için bir haftalık tahminde hatalar birikmez. Backend açılışında tüm bölgeler için 168 saatlik tahmin tek seferde üretilip kaydedilir;
zaman geçtikçe gerçekleşenle karşılaştırılır.

Kısa vadeli ve trend modelleri haftalık bakımda yeniden eğitilir; yeni model öncekinden %5'ten fazla kötüyse
devreye alınmaz.

**Anomali tespiti (TFT):** Model her bölge için bir sonraki 15 dakikanın doluluk aralığını tahmin eder.
Girdiler: son 8 saatlik doluluk, dünün aynı saati, giriş−çıkış akışı, sinema seansları, zaman ve hava
bilgisi. Gözlenen değer bu aralığın ne kadar dışındaysa skor o kadar yüksek olur, eşik aşılınca anomali
sayılır. Yönü (artış/azalış) de buradan belirlenir. Eğitim verisine az miktarda yapay anomali eklenir;
eşik canlı haftaya bakılmadan seçilir.

Anomali oranı çok düşük (~%0.5) olduğu için başarı accuracy ile değil **precision / recall / F1** ile ölçülür.

## Kurulum

Gereksinimler: Python 3.11+ (3.14 ile test edildi), Node.js 20+.

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Açılışta veri üretimi ve model eğitimi yapıldığı için API'nin hazır olması biraz sürer.
TFT anomali modeli repoda hazır gelir (`backend/ml/artifacts/*/anomaly_tft/`); silinirse açılışta yeniden eğitilir
(bu uzun sürer). Elle yeniden eğitmek için: `python -m app.train_anomaly`.

`--reload` kullanmayın: her kod değişikliğinde tüm sıfırlama ve eğitim tekrar çalışır.

### Web

```bash
cd apps/web
npm install
npm run dev
```

Arayüz http://localhost:3000 adresinde açılır. Backend adresi varsayılan olarak `http://localhost:8000`;
değiştirmek için `apps/web/.env.example` dosyasını `.env.local` olarak kopyalayıp düzenleyin.

## API

Tüm AVM'ye özel uç noktalar `/malls/{slug}/` altındadır (`slug`: `mall-a` veya `mall-b`).
Etkileşimli dokümantasyon: http://localhost:8000/docs

| Uç nokta | Açıklama |
|---|---|
| `GET /health`, `GET /malls` | Sağlık kontrolü, AVM listesi |
| `GET /malls/{slug}/floors`, `/zones` | Katlar ve bölgeler |
| `GET /malls/{slug}/occupancy`, `/dashboard/summary` | Anlık doluluk |
| `GET /malls/{slug}/dashboard/compare` | Dashboard özeti ve günlük doluluk eğrisi |
| `GET /malls/{slug}/floors/timeline` | Kat bazında günlük eğri + tahmin |
| `GET /malls/{slug}/predict/{zone_code}` | Kısa vadeli tahmin, risk ve öneri |
| `GET /malls/{slug}/trend/forecast?zone=...` | Haftalık trend tahmini |
| `GET /malls/{slug}/alerts`, `/alerts/history` | Aktif uyarılar ve geçmiş |
| `GET /malls/{slug}/anomalies/events` | Anomali olayları |
| `GET /malls/{slug}/reports/weekly` | Haftalık karşılaştırma raporu |
| `GET /malls/{slug}/parking` | Otopark durumu |
| `GET /malls/{slug}/stores/search?q=...` | Mağaza arama |
| `GET /malls/{slug}/models/accuracy` | Modellerin canlı doğruluğu |
| `WS  /malls/{slug}/ws/live` | Canlı doluluk, tahmin ve uyarılar |
| `GET/POST /malls/{slug}/simulation/...` | Simülasyon durumu, başlat/durdur, hız |

## Klasör yapısı

```
backend/
  app/
    main.py                 API ve uygulama yaşam döngüsü
    reset.py                açılışta veritabanı + modellerin sıfırdan kurulması
    synthetic.py            sentetik veri üreteci
    simulation.py           canlı simülasyon döngüsü
    mall_blueprints.py      örnek AVM tanımları (katlar, bölgeler, mağazalar)
    train_model.py, predict.py      kısa vadeli tahmin
    trend.py                LSTM trend tahmini
    anomaly_tft.py          TFT anomali tespiti
    maintenance.py, retention.py    haftalık yeniden eğitim ve veri saklama
    weekly_report.py, dashboard_compare.py, floor_timeline.py   rapor/dashboard verileri
  ml/artifacts/             eğitilmiş modeller (sadece TFT repoda)
apps/web/src/
  app/                      sayfalar (dashboard, live-map, parking-3d, reports, notifications, ...)
  components/               kat planları, 3D bina, uyarı kartları, ...
  lib/                      API istemcisi, WebSocket ve bildirim durumu
docs/
  ROADMAP.md                geliştirme süreci günlüğü ve tasarım kararları
```

## Bilinen sınırlamalar

- Veri sentetiktir; model başarıları simülatörün ürettiği desenlere göredir, gerçek bir AVM'de farklı olabilir.
- Kimlik doğrulama yoktur; yerel kullanım içindir.
- Her açılış veritabanını sıfırladığı için canlı doğruluk sayaçları yeniden başlatmalar arasında birikmez.
