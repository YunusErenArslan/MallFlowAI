"""Geçmişe dönük sentetik veri üretici — ML model eğitimi için.

Kullanım:
    python -m app.generate_historical             # TÜM AVM'ler için TRAINING_WINDOW_DAYS kadar üretir
    python -m app.generate_historical --days 60    # son 60 günü üretir
    python -m app.generate_historical --force       # mevcut crowd_readings'i silip yeniden üretir
"""

import argparse
from datetime import datetime, timedelta

from .database import SessionLocal
from .mall_config import mall_config_from_row
from .models import CrowdReading, Event, Mall, WeatherReading, Zone
from .retention import TRAINING_WINDOW_DAYS
from .synthetic import CINEMA_SESSION_HOURS, event_boost_for_cinema, generate_reading, random_weather, rng_for

INTERVAL_MINUTES = 15


def _daterange(start: datetime, end: datetime, step_minutes: int):
    current = start
    while current < end:
        yield current
        current += timedelta(minutes=step_minutes)


def generate(mall: Mall, days: int, force: bool = False) -> None:
    """Faz 8.1: `mall_id` filtresi ZORUNLU — özellikle `force` dalındaki
    silme işlemleri (eskiden filtresizdi, bir AVM yenilenirken DİĞER AVM'nin
    verisini de silerdi)."""
    config = mall_config_from_row(mall)
    rng = rng_for(mall.id)
    db = SessionLocal()
    try:
        if not force and db.query(CrowdReading).filter(CrowdReading.mall_id == mall.id).count() > 0:
            print(f"{mall.slug}: crowd_readings zaten dolu, atlanıyor (yeniden üretmek için --force kullan).")
            return

        if force:
            db.query(CrowdReading).filter(CrowdReading.mall_id == mall.id).delete()
            db.query(Event).filter(Event.mall_id == mall.id).delete()
            db.query(WeatherReading).filter(WeatherReading.mall_id == mall.id).delete()
            db.commit()

        # NOT (Faz 7.106): `.order_by(Zone.id)` KRİTİK — bu fonksiyon zone başına
        # `random.*` çağrısı tüketiyor (hava/gürültü). Sıra garanti değilse (ORDER
        # BY yoksa) seed aynı olsa bile "sıradaki rastgele sayı" farklı bir zone'a
        # denk gelebilir, restart'lar arası sonuçlar kayar — bu tam da gözlemlenen
        # determinizm sızıntısıydı.
        zones = db.query(Zone).filter(Zone.mall_id == mall.id).order_by(Zone.id).all()
        if not zones:
            print(f"{mall.slug}: zone yok — önce seed_zones.seed_mall_zones() çalıştırılmalı.")
            return

        # NOT (Faz 7.106): `datetime.now()` (GERÇEK saat) DEĞİL — bkz. synthetic.py'deki
        # REFERENCE_NOW açıklaması, restart'lar arası tam tekrarlanabilirlik için.
        from .synthetic import REFERENCE_NOW

        now = REFERENCE_NOW
        start = now - timedelta(days=days)

        # gün başına hava durumu (her 6 saatte bir kayıt)
        day_weather: dict[str, str] = {}
        cursor = start.replace(hour=0)
        while cursor < now:
            day_key = cursor.strftime("%Y-%m-%d")
            condition = random_weather(rng)
            day_weather[day_key] = condition
            for hour in (0, 6, 12, 18):
                db.add(
                    WeatherReading(
                        mall_id=mall.id,
                        timestamp=cursor.replace(hour=hour),
                        condition=condition,
                        temperature=round(rng.uniform(8, 30), 1),
                    )
                )
            cursor += timedelta(days=1)

        # sinema seansları — her gün, her seans %70 ihtimalle gerçekleşsin
        # (bu AVM'de sinema zone'u yoksa — bkz. Mall B — cinema_zone None kalır,
        # aşağıdaki `if cinema_zone:` bloğu atlanır, tamamen normal bir yol)
        cinema_zone = next((z for z in zones if z.zone_type == "cinema"), None)
        day_sessions: dict[str, list[float]] = {}
        cursor = start.replace(hour=0)
        while cursor < now:
            day_key = cursor.strftime("%Y-%m-%d")
            sessions_today = [h for h in CINEMA_SESSION_HOURS if rng.random() < 0.7]
            day_sessions[day_key] = sessions_today
            if cinema_zone:
                for h in sessions_today:
                    session_start = cursor.replace(hour=int(h), minute=int((h % 1) * 60))
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
            cursor += timedelta(days=1)

        db.commit()

        prev_counts: dict[int, int] = {z.id: 0 for z in zones}
        total_rows = 0

        for dt in _daterange(start, now, INTERVAL_MINUTES):
            day_key = dt.strftime("%Y-%m-%d")
            weather_condition = day_weather.get(day_key, "gunesli")
            sessions_today = day_sessions.get(day_key, [])

            for zone in zones:
                event_boost = 0.0
                if zone.zone_type == "cinema":
                    event_boost = event_boost_for_cinema(dt, sessions_today)

                person_count, entries, exits = generate_reading(
                    zone_type=zone.zone_type,
                    capacity=zone.capacity,
                    dt=dt,
                    weather_condition=weather_condition,
                    prev_count=prev_counts[zone.id],
                    config=config,
                    rng=rng,
                    event_boost=event_boost,
                )
                prev_counts[zone.id] = person_count

                db.add(
                    CrowdReading(
                        mall_id=mall.id,
                        zone_id=zone.id,
                        timestamp=dt,
                        person_count=person_count,
                        entries=entries,
                        exits=exits,
                        source="synthetic",
                    )
                )
                total_rows += 1

            if total_rows % 5000 < len(zones):
                db.commit()

        db.commit()
        print(f"{mall.slug}: {days} günlük veri üretildi: {total_rows} crowd_readings satırı, {len(zones)} zone.")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=TRAINING_WINDOW_DAYS)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--mall-slug", type=str, default=None, help="Belirtilmezse tüm AVM'ler için üretir.")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        query = db.query(Mall)
        if args.mall_slug:
            query = query.filter(Mall.slug == args.mall_slug)
        malls = query.order_by(Mall.id).all()
    finally:
        db.close()

    for mall in malls:
        generate(mall, days=args.days, force=args.force)
