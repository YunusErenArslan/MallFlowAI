from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import anomaly_tft, models, simulation
from .alert_history import alert_history
from .alerts import alerts_from_snapshot
from .anomaly import (
    total_week_anomalies,
    total_week_normal,
)
from .boot import BOOT_ID
from .dashboard_compare import dashboard_compare
from .database import Base, engine, get_db
from .floor_timeline import floor_timeline
from .weekly_report import weekly_report
from .model_metrics import live_accuracy, training_metrics, unified_accuracy
from .occupancy import dashboard_summary, zone_occupancy_snapshot
from .parking import parking_status
from .predict import ModelsNotTrainedError, predict_for_zone
from .reports import full_report
from .reset import get_all_malls, reset_to_initial_state
from .stores import list_categories, search_stores
from .trend import get_all_forecasts, get_forecast_with_actuals
from .ws import manager_for

Base.metadata.create_all(bind=engine)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Tasarım kararı: her başlangıçta sabit/tekrarlanabilir bir "ilk gün"
    # durumu — DB + modeller sıfırdan üretilir (bkz. reset.py, ROADMAP Faz 7.14).
    # Faz 8.1: artık TEK AVM değil, `MALL_BLUEPRINTS`'teki TÜM AVM'ler kuruluyor
    # — her biri için ayrı bir canlı simülasyon görevi başlatılıyor.
    reset_to_initial_state()
    for mall in get_all_malls():
        simulation.start(mall.id)
    yield
    for mall in get_all_malls():
        simulation.stop(mall.id)


app = FastAPI(title="MallFlow AI API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_mall(mall_slug: str, db: Session = Depends(get_db)) -> models.Mall:
    """Faz 8.1: her `/malls/{mall_slug}/...` isteğinin dayandığı AVM'yi
    çözümler — bulunamazsa 404."""
    mall = db.query(models.Mall).filter(models.Mall.slug == mall_slug).first()
    if mall is None:
        raise HTTPException(status_code=404, detail="AVM bulunamadı")
    return mall


@app.get("/health")
def health():
    return {"status": "ok", "boot_id": BOOT_ID}


@app.get("/malls")
def list_malls(db: Session = Depends(get_db)):
    malls = db.query(models.Mall).order_by(models.Mall.id).all()
    return [
        {
            "slug": m.slug,
            "name": m.name,
            "opening_hour": m.opening_hour,
            "closing_hour": m.closing_hour,
            "zone_count": db.query(models.Zone).filter(models.Zone.mall_id == m.id).count(),
        }
        for m in malls
    ]


@app.get("/malls/{mall_slug}/floors")
def list_floors(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    floors = (
        db.query(models.Floor)
        .filter(models.Floor.mall_id == mall.id)
        .order_by(models.Floor.level_order)
        .all()
    )
    return [{"code": f.code, "name": f.name, "level_order": f.level_order} for f in floors]


@app.get("/malls/{mall_slug}/zones")
def list_zones(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    zones = db.query(models.Zone).filter(models.Zone.mall_id == mall.id).all()
    return [
        {
            "code": z.code,
            "name": z.name,
            "floor_id": z.floor_id,
            "zone_type": z.zone_type,
            "capacity": z.capacity,
        }
        for z in zones
    ]


@app.get("/malls/{mall_slug}/occupancy")
def current_occupancy(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    return zone_occupancy_snapshot(db, mall.id)


@app.get("/malls/{mall_slug}/dashboard/summary")
def dashboard_summary_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    return dashboard_summary(db, mall)


@app.get("/malls/{mall_slug}/alerts")
def alerts_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    snapshot = zone_occupancy_snapshot(db, mall.id)
    return alerts_from_snapshot(snapshot) + anomaly_tft.anomaly_alerts(db, mall, snapshot)


@app.get("/malls/{mall_slug}/anomalies/events")
def anomaly_events_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    summary, events = anomaly_tft.live_summary_and_events(db, mall)
    summary["known_anomalies"] = summary["true_positives"] + summary["false_negatives"]
    summary["total_week_anomalies"] = total_week_anomalies(db, mall)
    summary["total_week_normal"] = total_week_normal(db, mall)
    return {"summary": summary, "events": events}


@app.get("/malls/{mall_slug}/alerts/history")
def alert_history_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    """Bildirimler sayfası: bu haftanın tüm bildirimleri (zil ile aynı kurallar)."""
    return alert_history(db, mall)


@app.get("/malls/{mall_slug}/floors/timeline")
def floors_timeline_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    """Dashboard kat görünümü: her katın bugünkü doluluk eğrisi + gün sonuna kadar tahmin."""
    return floor_timeline(db, mall)


@app.get("/malls/{mall_slug}/reports/weekly")
def reports_weekly(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    """Raporlar sayfası: bu hafta / geçen hafta karşılaştırması, günlük seri, gün×saat ısı haritası, bölge/kat tabloları."""
    return weekly_report(db, mall)


@app.get("/malls/{mall_slug}/dashboard/compare")
def dashboard_compare_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    """Dashboard KPI'ları: şu an ile dün aynı saatin karşılaştırması + bugünün/dünün eğrisi."""
    return dashboard_compare(db, mall)


@app.get("/malls/{mall_slug}/parking")
def parking_endpoint(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    return parking_status(db, mall.id)


@app.get("/malls/{mall_slug}/reports/summary")
def reports_summary(mall: models.Mall = Depends(get_mall)):
    return full_report(engine, mall.id)


@app.get("/malls/{mall_slug}/stores/search")
def stores_search(mall: models.Mall = Depends(get_mall), q: str = "", db: Session = Depends(get_db)):
    return search_stores(db, mall.id, q)


@app.get("/malls/{mall_slug}/stores/categories")
def stores_categories(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    return list_categories(db, mall.id)


@app.get("/malls/{mall_slug}/trend/forecast")
def trend_forecast(zone: str, mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    zone_obj = db.query(models.Zone).filter(models.Zone.mall_id == mall.id, models.Zone.code == zone).first()
    if zone_obj is None:
        raise HTTPException(status_code=404, detail="Zone bulunamadı")
    forecast = get_forecast_with_actuals(db, zone_obj)
    if forecast is None:
        raise HTTPException(status_code=503, detail="Trend modeli henüz eğitilmedi veya yeterli veri yok")
    return {"zone_code": zone_obj.code, "zone_name": zone_obj.name, "forecast": forecast}


@app.get("/malls/{mall_slug}/trend/forecast/all")
def trend_forecast_all(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    """Faz 7.99: `/trend` sayfasındaki kat krokisi + zaman kaydırıcısı için —
    tüm zone'ların en son tahmin serisi tek istekte."""
    return get_all_forecasts(db, mall.id)


@app.get("/malls/{mall_slug}/predict/{zone_code}")
def predict(zone_code: str, mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    zone = db.query(models.Zone).filter(models.Zone.mall_id == mall.id, models.Zone.code == zone_code).first()
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone bulunamadı")
    try:
        return predict_for_zone(db, zone, mall.id)
    except ModelsNotTrainedError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/malls/{mall_slug}/model/metrics")
def model_metrics(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    reference_time = (
        db.query(func.max(models.CrowdReading.timestamp))
        .filter(models.CrowdReading.mall_id == mall.id)
        .scalar()
        or datetime.now()
    )
    return {
        "training": training_metrics(mall.id),
        "live": live_accuracy(db, mall.id, reference_time=reference_time),
    }


@app.get("/malls/{mall_slug}/models/accuracy")
def models_accuracy(mall: models.Mall = Depends(get_mall), db: Session = Depends(get_db)):
    return unified_accuracy(db, mall)


@app.websocket("/malls/{mall_slug}/ws/live")
async def ws_live(websocket: WebSocket, mall_slug: str):
    db = next(get_db())
    try:
        mall = db.query(models.Mall).filter(models.Mall.slug == mall_slug).first()
        if mall is None:
            await websocket.close(code=4404)
            return
        manager = manager_for(mall.id)
        await manager.connect(websocket)
        try:
            await websocket.send_json(
                {
                    "type": "occupancy_update",
                    **dashboard_summary(db, mall),
                    "zone_predictions": simulation.last_predictions(mall.id),
                    "parking": parking_status(db, mall.id),
                    # Bağlantı kopukken (ya da sayfa yenilenirken) kaçırılmış
                    # olabilecek anomali alarmları — istemci son gördüğü tick'ten
                    # sonrasını zile ekler (anomaliler tek tick sürdüğü için
                    # canlı yayında bir daha görünmezler).
                    "recent_anomaly_alerts": anomaly_tft.recent_anomaly_alerts(db, mall),
                }
            )
        finally:
            pass
    finally:
        db.close()

    try:
        while True:
            # istemciden mesaj beklemiyoruz, sadece bağlantı kopunca WebSocketDisconnect fırlasın diye dinliyoruz
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@app.get("/malls/{mall_slug}/simulation/status")
def simulation_status(mall: models.Mall = Depends(get_mall)):
    return simulation.status(mall.id)


@app.post("/malls/{mall_slug}/simulation/start")
def simulation_start(mall: models.Mall = Depends(get_mall)):
    simulation.start(mall.id)
    return simulation.status(mall.id)


@app.post("/malls/{mall_slug}/simulation/stop")
def simulation_stop(mall: models.Mall = Depends(get_mall)):
    simulation.stop(mall.id)
    return simulation.status(mall.id)


@app.post("/malls/{mall_slug}/simulation/speed")
def simulation_speed(multiplier: float, mall: models.Mall = Depends(get_mall)):
    simulation.set_speed(mall.id, multiplier)
    return simulation.status(mall.id)
