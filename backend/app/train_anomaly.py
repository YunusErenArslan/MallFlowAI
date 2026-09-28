"""TFT anomali modelini TÜM AVM'ler için (yeniden) eğitir ve kaydeder.

Normal başlangıçta gerekmez — reset kayıtlı modeli kullanır, yoksa eğitir
(bkz. `anomaly_tft.ensure_trained`). Bu script, config değiştiğinde ya da
modeli bilinçli olarak tazelemek istediğinde elle çalıştırmak için.

Kullanım:
    python -m app.train_anomaly
"""

import time

from . import anomaly_tft
from .database import SessionLocal, engine
from .models import Mall


def main() -> None:
    with SessionLocal() as db:
        malls = db.query(Mall).order_by(Mall.id).all()
    for mall in malls:
        t0 = time.time()
        _, meta = anomaly_tft.train(engine, mall)
        print(
            f"{mall.slug}: TFT eğitildi ({time.time() - t0:.0f} sn) — doğrulama PR-AUC %{meta['val_pr_auc_pct']}, "
            f"eşik {meta['threshold']['threshold']}"
        )


if __name__ == "__main__":
    main()
