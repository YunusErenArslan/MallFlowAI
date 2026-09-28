"""Canlı (akan) simülasyon motoru.

Backend ayaktayken arka planda çalışır, simüle bir saati hızlandırılmış şekilde
ilerletir ve her 15 simüle dakikada bir tüm zone'lar için crowd_readings
satırı "açığa çıkarır" (reveal). Hız, /simulation endpoint'leri üzerinden
kontrol edilir.

Faz 8.1: tekil global `state = SimulationState()` nesnesi, `mall_id`'ye göre
anahtarlanan bir sözlüğe (`_states`) dönüştürüldü — her AVM kendi bağımsız
saatini/bakım döngüsünü yürütüyor, `main.py`'nin lifespan'i her AVM için ayrı
bir `asyncio.Task` başlatıyor (`start(mall_id)`).

Faz 8.11: bu modül artık veri ÜRETMİYOR — 7 günlük canlı hafta reset anında
TOPLU olarak `generate_live_week.py` tarafından `StagedCrowdReading`/
`StagedWeatherReading`e önceden yazılıyor. Bu döngü sadece zaman geldikçe
o tick'in zaten hazır satırlarını gerçek `CrowdReading`/`WeatherReading`
tablolarına KOPYALIYOR (açığa çıkarıyor) — kullanıcı deneyimi (saniyede bir
güncellenen "canlı" dashboard) birebir aynı kalıyor, sadece verinin NE ZAMAN
üretildiği değişti."""

import asyncio
import logging
from datetime import datetime, timedelta

import pandas as pd

from . import anomaly_tft, maintenance
from .database import SessionLocal
from .models import (
    CrowdReading,
    Mall,
    StagedCrowdReading,
    StagedWeatherReading,
    TFTAnomalyDetection,
    WeatherReading,
    Zone,
)
from .occupancy import dashboard_summary
from .parking import parking_status
from .predict import ModelsNotTrainedError, predict_for_zone
from .retention import MAINTENANCE_INTERVAL_DAYS
from .synthetic import REFERENCE_NOW
from .ws import manager_for

TICK_SECONDS = 1.0
INTERVAL_MINUTES = 15
DEFAULT_SPEED_MULTIPLIER = 900.0  # 1 gerçek sn = 900 simüle sn -> 15 sim dakika ~ her 1 sn
MAX_LIVE_SIMULATION_DAYS = 7  # 30 günlük geçmiş veriden SONRA canlı simülasyon bu kadar gün ilerleyip kendiliğinden durur


class SimulationState:
    def __init__(self, mall_id: int) -> None:
        self.running = False
        self.speed_multiplier = DEFAULT_SPEED_MULTIPLIER
        self.sim_time = REFERENCE_NOW
        self.sim_start_time: datetime | None = None  # canlı simülasyonun başladığı an — MAX_LIVE_SIMULATION_DAYS'in çapası
        self.task: asyncio.Task | None = None
        self.accumulated = timedelta()
        # Faz 8.11: `sessions_day_key` artık RNG'den bağımsız — sadece "bu
        # günün hava kaydı açığa çıkarıldı mı" bilgisini tutan bir imleç.
        # `prev_counts`/`current_weather`/`sessions_today` kaldırıldı: bunlar
        # sadece CANLI ÜRETİM için gerekliydi (artık `generate_live_week.py`
        # reset anında, tek seferde hesaplıyor), açığa çıkarma bunlara
        # ihtiyaç duymuyor.
        self.sessions_day_key: str | None = None
        self.tick_count = 0
        self.last_maintenance_sim_time: datetime | None = None
        self.is_running_maintenance = False
        self.last_maintenance_summary: dict | None = None
        # Faz 8.13: her tick'te ZATEN her zone için hesaplanan (ama eskiden
        # atılan) `predict_for_zone` sonuçları — "Kısa Vadeli Tahminler"/
        # "Otopark" sayfalarının WebSocket yayınında BEDAVA (ek hesap
        # maliyeti olmadan) kullanabilmesi için burada saklanıyor.
        self.last_predictions: dict[str, dict] = {}


# Faz 8.1: `mall_id -> SimulationState`. Her AVM kendi state'ini burada tutar.
_states: dict[int, SimulationState] = {}


def _get_state(mall_id: int) -> SimulationState:
    return _states.setdefault(mall_id, SimulationState(mall_id))


def _maybe_refresh_day_context(db, mall_id: int) -> None:
    """Faz 8.11: yeni hava ÇEKMİYOR — `generate_live_week.py`'nin bu gün için
    ÖNCEDEN üretip `staged_weather_readings`e yazdığı satırı bulup gerçek
    `weather_readings`e KOPYALIYOR. `generate_live_week`'in gün sınırı
    mantığı (sim_time REFERENCE_NOW'dan başlayıp her tick'te 15dk ileri
    gitmesi) burayla BİREBİR aynı olduğu için, `state.sim_time` zaten o
    satırın tam zaman damgasına denk geliyor — aramaya tolerans gerekmiyor."""
    state = _get_state(mall_id)
    day_key = state.sim_time.strftime("%Y-%m-%d")
    if day_key == state.sessions_day_key:
        return
    state.sessions_day_key = day_key
    staged = (
        db.query(StagedWeatherReading)
        .filter(StagedWeatherReading.mall_id == mall_id, StagedWeatherReading.timestamp == state.sim_time)
        .first()
    )
    if staged is not None:
        db.add(
            WeatherReading(
                mall_id=mall_id,
                timestamp=staged.timestamp,
                condition=staged.condition,
                temperature=staged.temperature,
            )
        )
        db.flush()
    _maybe_trigger_weekly_maintenance(mall_id)


def _run_weekly_maintenance(mall_id: int) -> None:
    state = _get_state(mall_id)
    db = SessionLocal()
    try:
        mall = db.get(Mall, mall_id)
        try:
            summary = maintenance.run_weekly_maintenance(mall, state.sim_time)
            state.last_maintenance_summary = summary
            print(
                f"[simulation:{mall.slug}] Haftalık bakım tamamlandı "
                f"(sim_time={state.sim_time.isoformat()}): {summary}"
            )
        finally:
            state.is_running_maintenance = False
    finally:
        db.close()


def _maybe_trigger_weekly_maintenance(mall_id: int) -> None:
    state = _get_state(mall_id)
    if state.last_maintenance_sim_time is None:
        # ilk çalıştırmada veri/model zaten güncel kabul edilir, hemen tetiklenmez
        state.last_maintenance_sim_time = state.sim_time
        return
    if state.is_running_maintenance:
        return
    if state.sim_time - state.last_maintenance_sim_time < timedelta(days=MAINTENANCE_INTERVAL_DAYS):
        return

    state.last_maintenance_sim_time = state.sim_time
    state.is_running_maintenance = True
    asyncio.get_running_loop().run_in_executor(None, _run_weekly_maintenance, mall_id)


def _generate_tick(mall_id: int) -> None:
    """Faz 8.11: adı hâlâ "_generate_tick" (çağıranlarla/loglarla tutarlılık
    için) ama artık ÜRETMİYOR — `generate_live_week.py`'nin bu tick için
    ÖNCEDEN üretip `staged_crowd_readings`e yazdığı satırları bulup gerçek
    `crowd_readings`e KOPYALIYOR (Karar B: kopyalama, taşıma değil — bekleme
    tablosundan silinmiyor, `anomaly.total_week_anomalies` hafta boyunca
    sabit kalabilsin diye)."""
    state = _get_state(mall_id)
    db = SessionLocal()
    try:
        zones = db.query(Zone).filter(Zone.mall_id == mall_id).order_by(Zone.id).all()
        if not zones:
            return

        _maybe_refresh_day_context(db, mall_id)

        staged_rows = (
            db.query(StagedCrowdReading)
            .filter(StagedCrowdReading.mall_id == mall_id, StagedCrowdReading.timestamp == state.sim_time)
            .order_by(StagedCrowdReading.zone_id)
            .all()
        )
        for staged in staged_rows:
            db.add(
                CrowdReading(
                    mall_id=mall_id,
                    zone_id=staged.zone_id,
                    timestamp=staged.timestamp,
                    person_count=staged.person_count,
                    entries=staged.entries,
                    exits=staged.exits,
                    source=staged.source,
                    is_injected_anomaly=staged.is_injected_anomaly,
                    direction=staged.direction,
                )
            )

        db.commit()
        state.tick_count += 1

        # Faz 8.13: sonuçlar artık ATILMIYOR — `state.last_predictions`'a
        # yazılıyor, `_broadcast_update` bunu WebSocket yayınına ekliyor.
        predictions: dict[str, dict] = {}
        for zone in zones:
            try:
                predictions[zone.code] = predict_for_zone(db, zone, mall_id)
            except ModelsNotTrainedError:
                break  # hiçbir zone için model yok, tekrar denemenin anlamı yok
        if predictions:
            state.last_predictions = predictions

        # Anomali tespiti (TFT): bu tick'in kararı `tft_anomaly_detections`'a yazılır.
        _persist_tft_detections(db, mall_id, state.sim_time)
    finally:
        db.close()


logger = logging.getLogger(__name__)


def _persist_tft_detections(db, mall_id: int, ts: datetime) -> None:
    """TFT'nin bu tick'teki kararı. Bir hata simülasyon döngüsünü durdurmasın
    diye yutulup loglanıyor (tahminler ve veri akışı çalışmaya devam eder)."""
    try:
        mall = db.get(Mall, mall_id)
        rows = anomaly_tft.detect_live(db, mall, ts)
        db.add_all([TFTAnomalyDetection(mall_id=mall_id, **row) for row in rows])
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("TFT anomali tespiti başarısız (mall_id=%s, ts=%s)", mall_id, ts)


async def _loop(mall_id: int) -> None:
    state = _get_state(mall_id)
    while state.running:
        await asyncio.sleep(TICK_SECONDS)
        if not state.running:
            break
        advance = timedelta(seconds=TICK_SECONDS * state.speed_multiplier)
        state.sim_time += advance
        state.accumulated += advance
        if state.accumulated >= timedelta(minutes=INTERVAL_MINUTES):
            state.accumulated -= timedelta(minutes=INTERVAL_MINUTES)
            _generate_tick(mall_id)
            await _broadcast_update(mall_id)

        if state.sim_start_time is not None and (
            state.sim_time - state.sim_start_time >= timedelta(days=MAX_LIVE_SIMULATION_DAYS)
        ):
            state.running = False
            print(
                f"[simulation:mall_id={mall_id}] Simülasyon akışı bitti — {MAX_LIVE_SIMULATION_DAYS} günlük canlı "
                f"simülasyon tamamlandı, kendiliğinden durduruldu (sim_time={state.sim_time.isoformat()})."
            )
            break


async def _broadcast_update(mall_id: int) -> None:
    manager = manager_for(mall_id)
    if not manager.active:
        return
    state = _get_state(mall_id)
    db = SessionLocal()
    try:
        mall = db.get(Mall, mall_id)
        # Faz 8.13: `zone_predictions` (her tick'te zaten hesaplanan,
        # BEDAVA) ve `parking` (ucuz, `zone_occupancy_snapshot`'ı yeniden
        # kullanıyor) yayına eklendi — "Kısa Vadeli Tahminler"/"Otopark"
        # sayfaları artık REST polling yerine bu yayını dinleyebiliyor.
        await manager.broadcast(
            {
                "type": "occupancy_update",
                **dashboard_summary(db, mall),
                "zone_predictions": state.last_predictions,
                "parking": parking_status(db, mall_id),
            }
        )
    finally:
        db.close()


def last_predictions(mall_id: int) -> dict:
    return _get_state(mall_id).last_predictions


def start(mall_id: int) -> None:
    state = _get_state(mall_id)
    if state.running:
        return
    state.running = True
    # NOT (Faz 7.106): `datetime.now()` DEĞİL, geçmiş verinin bittiği yerden
    # (REFERENCE_NOW) devam ediyor — bkz. synthetic.py, restart'lar arası tam
    # tekrarlanabilirlik için.
    state.sim_time = REFERENCE_NOW
    state.sim_start_time = state.sim_time
    state.accumulated = timedelta()
    state.task = asyncio.create_task(_loop(mall_id))


def stop(mall_id: int) -> None:
    state = _get_state(mall_id)
    state.running = False
    state.task = None


def set_speed(mall_id: int, multiplier: float) -> None:
    _get_state(mall_id).speed_multiplier = max(1.0, multiplier)


def status(mall_id: int) -> dict:
    state = _get_state(mall_id)
    return {
        "running": state.running,
        "speed_multiplier": state.speed_multiplier,
        "sim_time": state.sim_time.isoformat(),
        "sim_start_time": state.sim_start_time.isoformat() if state.sim_start_time else None,
        "max_live_simulation_days": MAX_LIVE_SIMULATION_DAYS,
        "ticks_generated": state.tick_count,
        "is_running_maintenance": state.is_running_maintenance,
        "last_maintenance_sim_time": (
            state.last_maintenance_sim_time.isoformat() if state.last_maintenance_sim_time else None
        ),
        "last_maintenance_summary": state.last_maintenance_summary,
    }
