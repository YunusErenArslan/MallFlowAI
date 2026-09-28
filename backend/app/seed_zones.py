"""Faz 8.1: çoklu AVM desteği — artık sabit bir FLOORS/ZONES listesi yerine,
`mall_blueprints.MallBlueprint`'ten parametrik olarak seed ediliyor. Eski
"herhangi bir zone varsa atla" koruması "bu slug'lı AVM zaten var mı"
korumasına döndü — aksi halde ikinci bir AVM'yi hiç seed edemezdik."""

from .database import Base, SessionLocal, engine
from .mall_blueprints import MallBlueprint
from .models import Floor, Mall, Zone


def seed_mall_zones(db, blueprint: MallBlueprint) -> Mall | None:
    existing = db.query(Mall).filter(Mall.slug == blueprint.slug).first()
    if existing is not None:
        print(f"{blueprint.slug} already seeded, skipping.")
        return existing

    mall = Mall(
        slug=blueprint.slug,
        name=blueprint.name,
        opening_hour=blueprint.opening_hour,
        closing_hour=blueprint.closing_hour,
        weekend_weekdays=sorted(blueprint.weekend_weekdays),
        weekend_multiplier=blueprint.weekend_multiplier,
        hourly_curve=list(blueprint.hourly_curve),
        closed_hours=sorted(blueprint.closed_hours),
        closed_hour_anomaly_threshold_pct=blueprint.closed_hour_anomaly_threshold_pct,
    )
    db.add(mall)
    db.flush()

    floor_by_code = {}
    for f in blueprint.floors:
        floor = Floor(mall_id=mall.id, code=f.code, name=f.name, level_order=f.level_order)
        db.add(floor)
        db.flush()
        floor_by_code[f.code] = floor

    for z in blueprint.zones:
        db.add(
            Zone(
                mall_id=mall.id,
                code=z.code,
                name=z.name,
                floor_id=floor_by_code[z.floor_code].id,
                zone_type=z.zone_type,
                capacity=z.capacity,
            )
        )

    db.commit()
    print(f"Seeded {blueprint.slug}: {len(blueprint.floors)} floors, {len(blueprint.zones)} zones.")
    return mall


def seed() -> None:
    """Geriye dönük CLI girişi — TÜM `MALL_BLUEPRINTS`'i sırayla seed eder.
    `python -m app.seed_zones` ile tek başına çalıştırılabilir."""
    from .mall_blueprints import MALL_BLUEPRINTS

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        for blueprint in MALL_BLUEPRINTS:
            seed_mall_zones(db, blueprint)
    finally:
        db.close()


if __name__ == "__main__":
    seed()
