"""TFT anomali modelini canlı haftanın TAMAMI üzerinde çevrimdışı ölçer —
çalışan simülasyona dokunmaz (sadece okur).

Değerlendirme seti: `staged_crowd_readings` — reset'te önceden üretilen 7
günlük canlı hafta, ground truth (`is_injected_anomaly`) ile. Simülasyonun
bitmesini beklemeden haftanın sonucunu verir.

Metrikler accuracy DEĞİL: anomali oranı ~%0.5 olduğu için "hep normal de"
bile %99.5 accuracy alır. Precision / recall / F1 + PR-AUC (eşikten
bağımsız) raporlanır.

Kullanım (backend/ klasöründen):
    .venv/bin/python -m app.evaluate_anomaly
    .venv/bin/python -m app.evaluate_anomaly --mall mall-a --retrain
"""

import argparse

from sklearn.metrics import average_precision_score

from . import anomaly_tft
from .database import SessionLocal, engine
from .models import Mall


def evaluate(mall_slug: str, retrain: bool) -> dict:
    with SessionLocal() as db:
        mall = db.query(Mall).filter(Mall.slug == mall_slug).one()
    series = anomaly_tft.load_mall_series(engine, mall)
    loaded = None if retrain else anomaly_tft.load(mall.id)
    if loaded is None or loaded[1]["zone_codes"] != series.zone_codes:
        print(f"[{mall_slug}] TFT eğitiliyor...")
        loaded = anomaly_tft.train(engine, mall, series=series)
    model, meta = loaded

    df = anomaly_tft.score_live_week(model, meta, series)
    y, p = df["is_injected_anomaly"].to_numpy(bool), df["is_outlier"].to_numpy(bool)
    result = anomaly_tft.detection_metrics(int((y & p).sum()), int((~y & p).sum()), int((y & ~p).sum()), int((~y & ~p).sum()))
    result["pr_auc_pct"] = round(100 * float(average_precision_score(y, df["score"])), 1) if y.any() else None
    fp = df[~y & p]
    result["false_positives_by_zone"] = fp["zone_name"].value_counts().to_dict()
    missed = df[y & ~p]
    result["missed"] = [
        {"timestamp": str(r.timestamp), "zone_name": r.zone_name, "occupancy_pct": round(r.occupancy_pct, 1), "expected_pct": round(r.expected_pct, 1)}
        for r in missed.itertuples()
    ]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mall", action="append", help="mall slug (tekrarlanabilir); varsayılan: hepsi")
    parser.add_argument("--retrain", action="store_true")
    args = parser.parse_args()
    slugs = args.mall
    if not slugs:
        with SessionLocal() as s:
            slugs = [m.slug for m in s.query(Mall).order_by(Mall.id)]
    for slug in slugs:
        r = evaluate(slug, args.retrain)
        known = r["true_positives"] + r["false_negatives"]
        print(
            f"== {slug}: yakalanan {r['true_positives']}/{known}, yanlış alarm {r['false_positives']} | "
            f"precision %{r['precision_pct']}  recall %{r['recall_pct']}  F1 %{r['f1_pct']}  PR-AUC %{r['pr_auc_pct']}"
        )
        for m in r["missed"]:
            print(f"   kaçırılan: {m}")
