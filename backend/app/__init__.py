import os

# Faz 7.108: tam determinizm için — numpy/sklearn/torch'un kullandığı BLAS
# kütüphaneleri (Accelerate/vecLib, OpenBLAS, MKL) varsayılan olarak ÇOK
# THREAD'Lİ çalışır; matris/histogram işlemlerini paralel parçalara bölüp
# sonuçları GERÇEK ZAMANLI thread zamanlamasına bağlı bir sırada toplar. Aynı
# seed'le bile, kayan noktalı toplama sırası her çalıştırmada mikroskobik
# farklı olabilir (iyi bilinen bir kısıt) — bu da eğitim boyunca birikip
# modelin (LSTM/HistGradientBoosting/IsolationForest) ağırlıklarını hafifçe
# değiştirebiliyordu (bkz. docs/ROADMAP.md Faz 7.106/7.107). Tek-thread'e zorlayınca
# toplama sırası da sabitleniyor, restart'lar arası bit-bit aynı sonuç garanti
# oluyor. Bu satırlar `numpy`/`torch`/`sklearn` HERHANGİ bir yerde import
# edilmeden ÖNCE çalışmalı — Python bir paketi ilk import ettiğinde önce onun
# `__init__.py`'ını çalıştırır, bu yüzden burada, dosyanın en başında olmaları
# yeterli garanti (app.main'in "from . import models, simulation" satırı bu
# dosyadan SONRA çalışır).
for _env_var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_env_var, "1")
