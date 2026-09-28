from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Mall(Base):
    """Çoklu AVM desteği (Faz 8.1) — her AVM kendi açılış/kapanış saatine,
    haftasonu/hava çarpanına ve saatlik doluluk eğrisine sahip. Bu satırlar
    `mall_config.MallConfig`'e yüklenip synthetic.py/anomaly.py'nin artık
    ZORUNLU parametre olarak aldığı yerlere geçiriliyor — modül seviyesi
    sabit YOK, her AVM kendi değerini DB'den okuyor."""

    __tablename__ = "malls"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)  # 'mall-a', 'mall-b' — URL kimliği
    name: Mapped[str] = mapped_column(String, nullable=False)
    opening_hour: Mapped[int] = mapped_column(Integer, nullable=False)
    closing_hour: Mapped[int] = mapped_column(Integer, nullable=False)
    weekend_weekdays: Mapped[list] = mapped_column(JSON, nullable=False)  # ör. [4,5,6]
    weekend_multiplier: Mapped[float] = mapped_column(Float, nullable=False)
    hourly_curve: Mapped[list] = mapped_column(JSON, nullable=False)  # 24 float
    closed_hours: Mapped[list] = mapped_column(JSON, nullable=False)  # ör. [22,23,0,1,...]
    closed_hour_anomaly_threshold_pct: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Floor(Base):
    __tablename__ = "floors"
    __table_args__ = (UniqueConstraint("mall_id", "code", name="uq_floors_mall_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String, nullable=False)  # 'ZEMIN', 'KAT_1', 'KAT_-1' — AVM içinde benzersiz
    name: Mapped[str] = mapped_column(String, nullable=False)  # 'Zemin Kat'
    level_order: Mapped[int] = mapped_column(Integer, nullable=False)  # -1, 0, 1, 2

    mall: Mapped["Mall"] = relationship()
    zones: Mapped[list["Zone"]] = relationship(back_populates="floor")


class Zone(Base):
    __tablename__ = "zones"
    __table_args__ = (
        CheckConstraint(
            "zone_type IN ('entrance','retail','food_court','cinema','parking',"
            "'walkway','kids_area','service','info_desk','entertainment')",
            name="ck_zones_zone_type",
        ),
        UniqueConstraint("mall_id", "code", name="uq_zones_mall_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String, nullable=False)  # 'ZONE_001' — AVM içinde benzersiz
    name: Mapped[str] = mapped_column(String, nullable=False)
    floor_id: Mapped[int] = mapped_column(ForeignKey("floors.id"), nullable=False)
    parent_zone_id: Mapped[int | None] = mapped_column(ForeignKey("zones.id"), nullable=True)
    zone_type: Mapped[str] = mapped_column(String, nullable=False)
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    mall: Mapped["Mall"] = relationship()
    floor: Mapped["Floor"] = relationship(back_populates="zones")
    parent: Mapped["Zone | None"] = relationship(remote_side=[id])


class CrowdReading(Base):
    __tablename__ = "crowd_readings"
    __table_args__ = (
        CheckConstraint(
            "source IN ('synthetic','camera','wifi','beacon','turnstile','parking_sensor','pos')",
            name="ck_crowd_readings_source",
        ),
        CheckConstraint(
            "direction IN ('Beklenmedik Ziyaretçi Artışı','Beklenmedik Ziyaretçi Azalışı')",
            name="ck_crowd_readings_direction",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    person_count: Mapped[int] = mapped_column(Integer, nullable=False)
    entries: Mapped[int] = mapped_column(Integer, default=0)
    exits: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String, default="synthetic")
    # senkron.py: maybe_inject_anomaly kasıtlı bir artış/azalış uyguladığında işaretlenir
    # (Faz 8.15'ten beri iki yönlü de olabiliyor) — anomali tespit modelinin
    # CANLI, gerçek doğruluğunu ölçmek için (bkz. model_metrics.py)
    is_injected_anomaly: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Faz 8.17: SADECE is_injected_anomaly=True satırlarda dolu — enjeksiyonun
    # GERÇEK yönü (bir önceki okumaya göre artış mı azalış mı). Alert'teki
    # `direction` (Faz 8.7, geçmiş-ortalamasına göre) alanından BAĞIMSIZ bir
    # ground-truth — ikisini karşılaştırıp "yön etiketi doğruluğu" ölçülebilsin
    # diye ekleniyor.
    direction: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('movie_session','concert','promotion','holiday','special_day')",
            name="ck_events_event_type",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int | None] = mapped_column(ForeignKey("zones.id"), nullable=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    start_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class WeatherReading(Base):
    """Faz 8.1: `mall_id` eklendi — önceden TÜM uygulama için TEK bir hava
    durumu zaman çizelgesi vardı (zone/AVM bağlantısı hiç yoktu). Çoklu AVM
    desteğinde her AVM'nin kendi bağımsız hava durumu akışı olması gerekiyor,
    bu yüzden bu sütun opsiyonel bir iyileştirme değil, zorunlu bir alan."""

    __tablename__ = "weather_readings"
    __table_args__ = (
        CheckConstraint(
            "condition IN ('gunesli','yagmurlu','bulutlu','karli')",
            name="ck_weather_readings_condition",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    condition: Mapped[str] = mapped_column(String, nullable=False)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class StagedCrowdReading(Base):
    """Faz 8.11: canlı 7 günlük haftanın TAMAMI reset anında toplu üretilip
    buraya yazılır — `simulation.py`'nin canlı tick döngüsü, zaman geldikçe
    bu tablodan `CrowdReading`'e KOPYALAR (satır SİLİNMEZ — "bu hafta toplam
    kaç anomali var" sayısının hafta boyunca sabit kalması için, bkz.
    `anomaly.total_week_anomalies`). `CrowdReading` ile BİREBİR aynı sütunlar."""

    __tablename__ = "staged_crowd_readings"
    __table_args__ = (
        CheckConstraint(
            "source IN ('synthetic','camera','wifi','beacon','turnstile','parking_sensor','pos')",
            name="ck_staged_crowd_readings_source",
        ),
        CheckConstraint(
            "direction IN ('Beklenmedik Ziyaretçi Artışı','Beklenmedik Ziyaretçi Azalışı')",
            name="ck_staged_crowd_readings_direction",
        ),
        UniqueConstraint("mall_id", "zone_id", "timestamp", name="uq_staged_crowd_readings_mall_zone_ts"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    person_count: Mapped[int] = mapped_column(Integer, nullable=False)
    entries: Mapped[int] = mapped_column(Integer, default=0)
    exits: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String, default="synthetic")
    is_injected_anomaly: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Faz 8.17: bkz. `CrowdReading.direction` — burada da SADECE
    # is_injected_anomaly=True satırlarda dolu, aynı anlam.
    direction: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class StagedWeatherReading(Base):
    """Faz 8.11: `StagedCrowdReading`'in hava durumu karşılığı — bkz. orada."""

    __tablename__ = "staged_weather_readings"
    __table_args__ = (
        CheckConstraint(
            "condition IN ('gunesli','yagmurlu','bulutlu','karli')",
            name="ck_staged_weather_readings_condition",
        ),
        UniqueConstraint("mall_id", "timestamp", name="uq_staged_weather_readings_mall_ts"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    condition: Mapped[str] = mapped_column(String, nullable=False)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Prediction(Base):
    __tablename__ = "predictions"
    __table_args__ = (
        CheckConstraint("horizon_minutes IN (15, 30, 45, 60)", name="ck_predictions_horizon"),
        CheckConstraint(
            "risk_level IN ('low','medium','high','critical')",
            name="ck_predictions_risk_level",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    horizon_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    predicted_count: Mapped[int] = mapped_column(Integer, nullable=False)
    predicted_occupancy_pct: Mapped[float] = mapped_column(Float, nullable=False)
    risk_level: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class TFTAnomalyDetection(Base):
    """TFT anomali modelinin (`anomaly_tft.py`) HER tick'teki kararı (önceki
    IsolationForest'ın `anomaly_detections` tablosunun yerini aldı).
    `expected_pct`/`band_*` TFT'nin o an için tahmin ettiği medyan ve %98'lik
    bant (q01–q99) — alarm açıklaması ("beklenen %35–48, gözlenen %10") için."""

    __tablename__ = "tft_anomaly_detections"
    __table_args__ = (
        UniqueConstraint("mall_id", "zone_id", "timestamp", name="uq_tft_anomaly_detections_mall_zone_ts"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    is_outlier: Mapped[bool] = mapped_column(Boolean, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    expected_pct: Mapped[float] = mapped_column(Float, nullable=False)
    band_low_pct: Mapped[float] = mapped_column(Float, nullable=False)
    band_high_pct: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class TrendForecast(Base):
    """Haftalık LSTM trend tahmininin her saatlik noktası — kısa-vadeli
    `Prediction` ile aynı prensip: tahmin anında kaydedilir, hedef saat
    gerçekleşince (canlı akan crowd_readings ile) otomatik karşılaştırılabilir
    (bkz. trend.live_accuracy). Bir hafta boyunca beklemeye gerek yok — her
    saatlik nokta kendi hedef zamanı geçer geçmez tek başına doğrulanabilir."""

    __tablename__ = "trend_forecasts"

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    target_timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    predicted_occupancy_pct: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('admin','operator')", name="ck_users_role"),
        UniqueConstraint("email"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, default="operator")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[int] = mapped_column(primary_key=True)
    mall_id: Mapped[int] = mapped_column(ForeignKey("malls.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)  # 'Starbucks'
    category: Mapped[str] = mapped_column(String, nullable=False, index=True)  # 'kahve'
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False)

    zone: Mapped["Zone"] = relationship()
