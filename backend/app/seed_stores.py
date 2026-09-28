"""Faz 8.1: çoklu AVM desteği — artık sabit bir STORES listesi yerine,
`mall_blueprints.MallBlueprint`'ten parametrik olarak seed ediliyor. `zone_code`
artık AVM içinde benzersiz olduğu için zone eşlemesi `mall.id`'ye göre
kapsamlandırılmış."""

from .database import Base, SessionLocal, engine
from .mall_blueprints import MallBlueprint
from .models import Mall, Store, Zone


def seed_mall_stores(db, mall: Mall, blueprint: MallBlueprint) -> None:
    if db.query(Store).filter(Store.mall_id == mall.id).count() > 0:
        print(f"{blueprint.slug} stores already seeded, skipping.")
        return

    zone_by_code = {z.code: z for z in db.query(Zone).filter(Zone.mall_id == mall.id).all()}
    missing = {s.zone_code for s in blueprint.stores if s.zone_code not in zone_by_code}
    if missing:
        print(f"Zone bulunamadı ({blueprint.slug}): {missing} — önce seed_mall_zones() çalıştır.")
        return

    for s in blueprint.stores:
        db.add(Store(mall_id=mall.id, name=s.name, category=s.category, zone_id=zone_by_code[s.zone_code].id))

    db.commit()
    print(f"Seeded {blueprint.slug}: {len(blueprint.stores)} stores.")


def seed() -> None:
    """Geriye dönük CLI girişi — TÜM `MALL_BLUEPRINTS`'i sırayla seed eder.
    `python -m app.seed_stores` ile tek başına çalıştırılabilir (önce
    `seed_zones.seed()` çalıştırılmış olmalı)."""
    from .mall_blueprints import MALL_BLUEPRINTS

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        for blueprint in MALL_BLUEPRINTS:
            mall = db.query(Mall).filter(Mall.slug == blueprint.slug).first()
            if mall is None:
                print(f"{blueprint.slug} AVM'si bulunamadı — önce seed_zones.seed() çalıştır.")
                continue
            seed_mall_stores(db, mall, blueprint)
    finally:
        db.close()


if __name__ == "__main__":
    seed()
