"""Mağaza arama: kategori/isim eşleşmesi + bulunduğu bölgenin anlık doluluğu.

Not: gerçek bir kat planı/koordinat sistemi olmadığı için "X dakika" gibi bir
yürüme süresi UYDURMUYORUZ — sadece kat ve doluluk bilgisi veriyoruz, bu daha
dürüst. Sıralama en az yoğun bölgeden başlıyor (Faz 7.2'deki otopark
önerisiyle aynı mantık: kullanıcıya en rahat seçeneği öne çıkar).
"""

from sqlalchemy.orm import Session

from . import models
from .occupancy import zone_occupancy_snapshot


def search_stores(db: Session, mall_id: int, query: str = "") -> list[dict]:
    query_lower = query.strip().lower()
    stores = db.query(models.Store).filter(models.Store.mall_id == mall_id).all()
    occupancy_by_zone = {z["code"]: z for z in zone_occupancy_snapshot(db, mall_id)}

    results = []
    for store in stores:
        if query_lower and query_lower not in store.name.lower() and query_lower not in store.category.lower():
            continue
        zone_occ = occupancy_by_zone.get(store.zone.code, {})
        results.append(
            {
                "store_id": store.id,
                "name": store.name,
                "category": store.category,
                "zone_code": store.zone.code,
                "zone_name": store.zone.name,
                "floor_name": store.zone.floor.name,
                "occupancy_pct": zone_occ.get("occupancy_pct"),
                "level": zone_occ.get("level"),
            }
        )

    results.sort(key=lambda r: (r["occupancy_pct"] is None, r["occupancy_pct"] or 0))
    return results


def list_categories(db: Session, mall_id: int) -> list[str]:
    rows = (
        db.query(models.Store.category)
        .filter(models.Store.mall_id == mall_id)
        .distinct()
        .order_by(models.Store.category)
        .all()
    )
    return [r[0] for r in rows]
