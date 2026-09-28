"""Haftalık trend (LSTM) modelini eğitir — kurulum adımı, DB'deki mevcut
30 günlük gerçek veriyle (t-7/14/21/28 lag'leriyle, tüm zone'lar havuzlanarak).

Kullanım:
    python -m app.train_trend
"""

from .database import engine
from .trend import train


def main() -> None:
    metrics = train(engine)
    if not metrics:
        print("Yeterli veri yok (t-28 lag için en az ~28 günlük geçmiş gerekiyor).")
        return
    print(f"MAE=±{metrics['mae']:.2f} puan doluluk (train={metrics['train_rows']}, test={metrics['test_rows']})")
    print("LSTM trend modeli kaydedildi.")


if __name__ == "__main__":
    main()
