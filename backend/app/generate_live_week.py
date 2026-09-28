"""Faz 8.11: canlı 7 günlük haftanın TAMAMINI reset anında toplu üretir —
`generate_historical.py`'nin 30 günlük geçmiş üretimiyle KARIŞTIRILMAMALI,
kasıtlı olarak FARKLI bir yapıda: `generate_historical.py` faz-ayrık (önce
TÜM hava, sonra TÜM sinema seansları, sonra TÜM zone×tick okumaları), ama
bu fonksiyon `simulation.py`'nin BUGÜNKÜ canlı tick döngüsünün (gün
değişince hava+seans çekilişi, ardından o günün her tick'inde zone×okuma
çekilişi İÇ İÇE geçmiş) TAM AYNI rastgele-sayı ÇEKİLİŞ SIRASINI birebir
taklit eder — aksi halde `rng_for(mall_id)` akışı kayar, bugünkü
sonuçlardan (ve restart-arası/AVM'ler-arası determinizm garantilerinden)
sapar (bkz. plan dosyasındaki "Kritik kısıtlama" notu).

Üretilen veri `CrowdReading`/`WeatherReading`'e DEĞİL, `StagedCrowdReading`/
`StagedWeatherReading`'e yazılır — `simulation.py`'nin canlı döngüsü, zaman
geldikçe buradan gerçek tablolara KOPYALAR (bkz. `simulation.py`'deki
`_generate_tick`/`_maybe_refresh_day_context`)."""

from datetime import timedelta

from .anomaly import DIRECTION_LABELS
from .database import SessionLocal
from .mall_config import mall_config_from_row
from .models import Event, Mall, StagedCrowdReading, StagedWeatherReading, Zone
from .synthetic import (
    CINEMA_SESSION_HOURS,
    DEFAULT_SCALE_NO_CAPACITY,
    REFERENCE_NOW,
    event_boost_for_cinema,
    generate_reading,
    maybe_inject_anomaly,
    random_weather,
    rng_for,
)

INTERVAL_MINUTES = 15
MAX_LIVE_SIMULATION_DAYS = 7


def generate_live_week(mall: Mall, days: int = MAX_LIVE_SIMULATION_DAYS) -> None:
    config = mall_config_from_row(mall)
    rng = rng_for(mall.id)
    db = SessionLocal()
    try:
        # önceki bir koşudan kalan bekleme verisi varsa (ör. force reset)
        # temizle — reset.py zaten her seferinde drop_all/create_all yapıyor
        # ama bu fonksiyon tek başına da çağrılabilir diye korumalı.
        db.query(StagedCrowdReading).filter(StagedCrowdReading.mall_id == mall.id).delete()
        db.query(StagedWeatherReading).filter(StagedWeatherReading.mall_id == mall.id).delete()
        db.commit()

        # NOT: `.order_by(Zone.id)` — simulation.py/generate_historical.py'deki
        # AYNI determinizm notu: sıra garantisi olmadan bu döngü zone başına
        # `random.*` tükettiği için restart'lar arası tekrarlanabilirlik bozulur.
        zones = db.query(Zone).filter(Zone.mall_id == mall.id).order_by(Zone.id).all()
        if not zones:
            return

        # Faz 8.22: `generate_historical.py`'deki AYNI desen — canlı haftanın
        # sinema seansları da GERÇEK `events` tablosuna yazılıyor (önceden
        # sadece bellekteki `sessions_today`'de kalıyordu, `has_event` özelliği
        # canlı hafta için hiç çalışmıyordu). `Event` sorguları (predict.py,
        # simulation.py) hep `start_time <= an <= end_time` gibi ZAMANA göre
        # sınırlı — ileri tarihli event'leri baştan yazmak veri sızıntısı
        # YARATMIYOR, hiçbir sorgu "tüm event'ler" diye bakmıyor.
        cinema_zone = next((z for z in zones if z.zone_type == "cinema"), None)

        sim_time = REFERENCE_NOW
        day_key: str | None = None
        current_weather = "gunesli"
        sessions_today: list[float] = []
        prev_counts: dict[int, int] = {z.id: 0 for z in zones}

        total_ticks = days * (24 * 60 // INTERVAL_MINUTES)
        rows_since_commit = 0

        for _ in range(total_ticks):
            # `simulation.py`'nin `_loop`'unda `state.sim_time += advance` her
            # zaman `_generate_tick`'ten ÖNCE çalışıyor — aynı sırayı koruyoruz.
            sim_time += timedelta(minutes=INTERVAL_MINUTES)

            tick_day_key = sim_time.strftime("%Y-%m-%d")
            if tick_day_key != day_key:
                day_key = tick_day_key
                current_weather = random_weather(rng)
                sessions_today = [h for h in CINEMA_SESSION_HOURS if rng.random() < 0.7]
                db.add(
                    StagedWeatherReading(
                        mall_id=mall.id,
                        timestamp=sim_time,
                        condition=current_weather,
                        temperature=round(rng.uniform(8, 30), 1),
                    )
                )
                if cinema_zone:
                    day_start = sim_time.replace(hour=0, minute=0, second=0, microsecond=0)
                    for h in sessions_today:
                        session_start = day_start.replace(hour=int(h), minute=int((h % 1) * 60))
                        db.add(
                            Event(
                                mall_id=mall.id,
                                zone_id=cinema_zone.id,
                                name="Film Gösterimi",
                                event_type="movie_session",
                                start_time=session_start,
                                end_time=session_start + timedelta(hours=2),
                            )
                        )

            for zone in zones:
                event_boost = 0.0
                if zone.zone_type == "cinema":
                    event_boost = event_boost_for_cinema(sim_time, sessions_today)

                person_count, entries, exits = generate_reading(
                    zone_type=zone.zone_type,
                    capacity=zone.capacity,
                    dt=sim_time,
                    weather_condition=current_weather,
                    prev_count=prev_counts.get(zone.id, 0),
                    config=config,
                    rng=rng,
                    event_boost=event_boost,
                )
                scale = zone.capacity or DEFAULT_SCALE_NO_CAPACITY
                pre_anomaly_count = person_count
                person_count, was_anomaly = maybe_inject_anomaly(person_count, scale, rng)
                direction = None
                if was_anomaly:
                    # Faz 8.15: entries/exits için basit bir yaklaşım — sayı
                    # enjeksiyon ÖNCESİ değere göre düştüyse `exits` artıyor,
                    # arttıysa `entries` (bu, DIRECTION ETİKETİYLE karıştırılmasın).
                    if person_count >= pre_anomaly_count:
                        entries += person_count // 4
                    else:
                        exits += (pre_anomaly_count - person_count) // 4

                    # Ground-truth yön = enjeksiyonun GERÇEK yönü (simülatör sayıyı
                    # kendisi artırıp/azalttığı için kesin biliniyor). Eskiden alarmla
                    # aynı kıstas olsun diye geçmiş-ortalamasından TAHMİN ediliyordu
                    # (Faz 8.17); alarm yönü artık TFT'nin beklenen değerinden geliyor
                    # (bkz. anomaly_tft.anomaly_alerts), o gerekçe kalmadı.
                    direction = DIRECTION_LABELS["yuksek" if person_count >= pre_anomaly_count else "dusuk"]
                prev_counts[zone.id] = person_count

                db.add(
                    StagedCrowdReading(
                        mall_id=mall.id,
                        zone_id=zone.id,
                        timestamp=sim_time,
                        person_count=person_count,
                        entries=entries,
                        exits=exits,
                        source="synthetic",
                        is_injected_anomaly=was_anomaly,
                        direction=direction,
                    )
                )
                rows_since_commit += 1

            if rows_since_commit >= 2000:
                db.commit()
                rows_since_commit = 0

        db.commit()
        print(f"{mall.slug}: {days} günlük canlı hafta önceden üretildi ({total_ticks} tick, {len(zones)} zone).")
    finally:
        db.close()
