"""Anomali tespiti — Temporal Fusion Transformer (TFT). Projenin TEK anomali
modeli (önceki IsolationForest kaldırıldı, gerekçe `anomaly.py`'de).

Yaklaşım ("beklenenden sapma"): TFT her zone için bir sonraki 15dk'lık okumanın
quantile'larını (q01/q05/q50/q95/q99) tahmin eder — girdi olarak son
`ENCODER_STEPS` okuma + bilinen bağlam (saat, gün, hafta sonu, hava, sinema
seansı, dünün aynı saati) + statik zone bilgisi (zone, zone tipi, kapasite).
Gerçek değer tahmin bandının ne kadar DIŞINA düşüyorsa anomali skoru o kadar
yüksek. IsolationForest'tan farkı: "bu değer tuhaf mı" değil, "bu zone'da,
bu saatte, bu hava/seans koşulunda BEKLENEN neydi" sorusunu soruyor — sinema
gece seansları veya açılış/kapanış geçişleri gibi bağlama bağlı normal
yoğunluklar bandın İÇİNDE kalıyor.

Tek, global bir model (tüm zone'lar havuzlanır, zone/zone tipi embedding'i ile
ayrışır) — trend.py'deki LSTM ile aynı prensip, zone başına veri az olduğu için.

Eşik test haftasına bakılarak DEĞİL, eğitim verisinin son `VAL_DAYS` gününe
synthetic.py'nin AYNI enjeksiyon kuralıyla yapay anomali eklenerek (canlı
prevalansla ağırlıklandırılmış F1 en yüksek olacak şekilde) seçiliyor.

Mimari: Lim et al. 2021 "Temporal Fusion Transformers for Interpretable
Multi-horizon Time Series Forecasting" — GRN, değişken seçim ağları (VSN),
statik bağlam, LSTM encoder/decoder, statik zenginleştirme, yorumlanabilir
çok başlı dikkat (interpretable multi-head attention), quantile çıktısı.
Horizon=1 (bir sonraki tick) — anomaliler tek-tick sıçrama olduğu için.
"""

import json
import math
import random
from dataclasses import asdict, dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.metrics import average_precision_score
from sqlalchemy import func
from sqlalchemy.engine import Engine

from .anomaly_forecasters import TiDE, TSMixer
from .features import ZONE_TYPES, zone_type_code
from .mall_config import mall_config_from_row
from .synthetic import (
    ANOMALY_DROP_MULTIPLIER_RANGE,
    ANOMALY_DIRECTION_UP_PROBABILITY,
    ANOMALY_MIN_FLOOR_FRACTION,
    ANOMALY_MULTIPLIER_RANGE,
    ANOMALY_PROBABILITY,
    ANOMALY_QUIET_BASELINE_FRACTION,
    DEFAULT_SCALE_NO_CAPACITY,
    REFERENCE_NOW,
    WEATHER_MULTIPLIER,
)

ARTIFACTS_ROOT = Path(__file__).resolve().parent.parent / "ml" / "artifacts"

STEPS_PER_DAY = 96
ENCODER_STEPS = 32  # son 8 saat
VAL_DAYS = 4
QUANTILES = (0.01, 0.05, 0.5, 0.95, 0.99)
Q_LO, Q_MED, Q_HI = 0, 2, 4
PCT_SCALE = 100.0  # ağa doluluk ~[0,1] aralığında veriliyor (trend.py ile aynı sebep)
EVENT_WINDOW = (pd.Timedelta(minutes=-15), pd.Timedelta(minutes=90))  # features.py ile aynı pencere

TIME_VARS = ["hour_sin", "hour_cos", "dow_sin", "dow_cos", "is_weekend", "weather"]


@dataclass(frozen=True)
class TFTConfig:
    arch: str = "tft"  # "tft" | "tide" | "tsmixer" (bkz. anomaly_forecasters.py)
    lag_days: tuple[int, ...] = (1,)  # "N gün önce aynı saatteki doluluk" özellikleri
    # giriş − çıkış sayacı (kapasiteye göre %). Doluluk sensöründen BAĞIMSIZ
    # ölçülen, aynı tick'te bilinen bir değer — model "bu akışla doluluk ne
    # olmalı"yı öğrenir; sayaçla tutarsız sıçramalar bandın dışına düşer.
    use_flow: bool = True
    # Eğitim geçmişine bu oranda yapay anomali eklenir (synthetic.py kuralıyla,
    # giriş/çıkış sayacı dahil). Anomali tick'lerinin KENDİSİ loss'a girmez —
    # model anomaliyi "tahmin etmeyi" değil, anomaliden SONRAKİ normale dönüşü
    # (ör. büyük çıkış akışı) normal saymayı öğrenir.
    augment_rate: float = 0.01
    d_model: int = 32
    n_heads: int = 4
    dropout: float = 0.1
    n_models: int = 1  # >1 → farklı seed'lerle eğitilmiş modellerin quantile ortalaması (ensemble)
    seed: int = 42
    epochs: int = 40
    patience: int = 6
    batch_size: int = 256

    def past_vars(self) -> list[str]:
        """Encoder adımındaki değişkenler — ilk sütun gözlenen doluluk."""
        flow = ["net_flow"] if self.use_flow else []
        return ["occupancy", *[f"lag_{d}d" for d in self.lag_days], "event", *flow, *TIME_VARS]

    def future_vars(self) -> list[str]:
        """Decoder (hedef) adımı — gözlenen doluluk HARİÇ, geri kalanı o an zaten biliniyor."""
        return self.past_vars()[1:]

    def first_index(self) -> int:
        return ENCODER_STEPS + max(self.lag_days, default=0) * STEPS_PER_DAY


def _artifacts_dir(mall_id: int) -> Path:
    return ARTIFACTS_ROOT / str(mall_id) / "anomaly_tft"


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class GLU(nn.Module):
    def __init__(self, d_in: int, d_out: int):
        super().__init__()
        self.fc = nn.Linear(d_in, 2 * d_out)

    def forward(self, x):
        return F.glu(self.fc(x), dim=-1)


class GRN(nn.Module):
    """Gated Residual Network — opsiyonel statik bağlam vektörüyle."""

    def __init__(self, d_in: int, d_hidden: int, d_out: int, d_context: int | None = None, dropout: float = 0.1):
        super().__init__()
        self.skip = nn.Linear(d_in, d_out) if d_in != d_out else nn.Identity()
        self.fc1 = nn.Linear(d_in, d_hidden)
        self.ctx = nn.Linear(d_context, d_hidden, bias=False) if d_context else None
        self.fc2 = nn.Linear(d_hidden, d_hidden)
        self.drop = nn.Dropout(dropout)
        self.glu = GLU(d_hidden, d_out)
        self.norm = nn.LayerNorm(d_out)

    def forward(self, x, context=None):
        a = self.fc1(x)
        if self.ctx is not None and context is not None:
            a = a + self.ctx(context)
        a = self.drop(self.fc2(F.elu(a)))
        return self.norm(self.skip(x) + self.glu(a))


class VariableSelection(nn.Module):
    """Her değişkeni ayrı GRN'den geçirip, statik bağlama göre öğrenilen
    softmax ağırlıklarıyla birleştirir — ağırlıklar yorumlanabilir
    ("model bu an için hangi değişkene ne kadar baktı")."""

    def __init__(self, n_vars: int, d: int, d_context: int | None, dropout: float):
        super().__init__()
        self.weights_grn = GRN(n_vars * d, d, n_vars, d_context, dropout)
        self.var_grns = nn.ModuleList([GRN(d, d, d, None, dropout) for _ in range(n_vars)])

    def forward(self, x, context=None):  # x: (..., n_vars, d)
        w = torch.softmax(self.weights_grn(x.flatten(-2), context), dim=-1)
        h = torch.stack([grn(x[..., i, :]) for i, grn in enumerate(self.var_grns)], dim=-2)
        return (w.unsqueeze(-1) * h).sum(-2), w


class GateAddNorm(nn.Module):
    def __init__(self, d: int, dropout: float):
        super().__init__()
        self.drop = nn.Dropout(dropout)
        self.glu = GLU(d, d)
        self.norm = nn.LayerNorm(d)

    def forward(self, x, residual):
        return self.norm(residual + self.glu(self.drop(x)))


class InterpretableMultiHeadAttention(nn.Module):
    """Başlıklar ayrı Q/K ama ORTAK V kullanır, çıktılar ortalanır — böylece
    ortalama dikkat ağırlığı tek başına yorumlanabilir."""

    def __init__(self, d: int, n_heads: int, dropout: float):
        super().__init__()
        self.d_k = d // n_heads
        self.q = nn.ModuleList([nn.Linear(d, self.d_k) for _ in range(n_heads)])
        self.k = nn.ModuleList([nn.Linear(d, self.d_k) for _ in range(n_heads)])
        self.v = nn.Linear(d, self.d_k)
        self.out = nn.Linear(self.d_k, d)
        self.drop = nn.Dropout(dropout)

    def forward(self, q, k, v):
        v_shared = self.v(v)
        heads, attns = [], []
        for q_proj, k_proj in zip(self.q, self.k):
            scores = q_proj(q) @ k_proj(k).transpose(-2, -1) / math.sqrt(self.d_k)
            attn = self.drop(torch.softmax(scores, dim=-1))
            heads.append(attn @ v_shared)
            attns.append(attn)
        return self.out(torch.stack(heads).mean(0)), torch.stack(attns).mean(0)


class TemporalFusionTransformer(nn.Module):
    def __init__(
        self,
        n_zones: int,
        n_past: int,
        n_future: int,
        d: int = 32,
        n_heads: int = 4,
        dropout: float = 0.1,
        n_quantiles: int = len(QUANTILES),
    ):
        super().__init__()
        # sürekli değişken başına Linear(1, d) — tek parametre tensörüyle
        self.past_w = nn.Parameter(torch.randn(n_past, d) * 0.1)
        self.past_b = nn.Parameter(torch.zeros(n_past, d))
        self.future_w = nn.Parameter(torch.randn(n_future, d) * 0.1)
        self.future_b = nn.Parameter(torch.zeros(n_future, d))

        # statik: zone, zone tipi, kapasite ölçeği
        self.zone_emb = nn.Embedding(n_zones, d)
        self.type_emb = nn.Embedding(len(ZONE_TYPES), d)
        self.cap_proj = nn.Linear(2, d)
        self.static_vsn = VariableSelection(3, d, None, dropout)
        self.ctx_select, self.ctx_enrich, self.ctx_h, self.ctx_c = (GRN(d, d, d, None, dropout) for _ in range(4))

        self.past_vsn = VariableSelection(n_past, d, d, dropout)
        self.future_vsn = VariableSelection(n_future, d, d, dropout)
        self.encoder = nn.LSTM(d, d, batch_first=True)
        self.decoder = nn.LSTM(d, d, batch_first=True)
        self.lstm_gate = GateAddNorm(d, dropout)
        self.enrich = GRN(d, d, d, d, dropout)
        self.attention = InterpretableMultiHeadAttention(d, n_heads, dropout)
        self.attn_gate = GateAddNorm(d, dropout)
        self.positionwise = GRN(d, d, d, None, dropout)
        self.out_gate = GateAddNorm(d, dropout)
        self.head = nn.Linear(d, n_quantiles)

    def forward(self, past, future, zone_idx, type_idx, cap):
        """past: (B, L, n_past)  future: (B, 1, n_future)  cap: (B, 2)
        Dönüş: (B, n_quantiles) quantile tahmini + yorumlanabilirlik sözlüğü."""
        static_in = torch.stack([self.zone_emb(zone_idx), self.type_emb(type_idx), self.cap_proj(cap)], dim=1)
        static, static_w = self.static_vsn(static_in)
        c_sel, c_enr = self.ctx_select(static), self.ctx_enrich(static)
        h0, c0 = self.ctx_h(static).unsqueeze(0), self.ctx_c(static).unsqueeze(0)

        L = past.shape[1]
        past_emb = past.unsqueeze(-1) * self.past_w + self.past_b
        future_emb = future.unsqueeze(-1) * self.future_w + self.future_b
        past_sel, past_w = self.past_vsn(past_emb, c_sel.unsqueeze(1).expand(-1, L, -1))
        future_sel, future_w = self.future_vsn(future_emb, c_sel.unsqueeze(1))

        enc_out, state = self.encoder(past_sel, (h0.contiguous(), c0.contiguous()))
        dec_out, _ = self.decoder(future_sel, state)
        vsn_seq = torch.cat([past_sel, future_sel], dim=1)
        temporal = self.lstm_gate(torch.cat([enc_out, dec_out], dim=1), vsn_seq)
        enriched = self.enrich(temporal, c_enr.unsqueeze(1).expand(-1, L + 1, -1))

        # horizon=1: tek sorgu decoder adımı, anahtarlar tüm geçmiş + kendisi (nedensel)
        query = enriched[:, -1:]
        attn_out, attn_w = self.attention(query, enriched, enriched)
        x = self.attn_gate(attn_out, query)
        x = self.out_gate(self.positionwise(x), temporal[:, -1:])
        quantiles = self.head(x).squeeze(1)
        return quantiles, {
            "static_weights": static_w,
            "past_weights": past_w,
            "future_weights": future_w.squeeze(1),
            "attention": attn_w.squeeze(1),
        }


class TFTEnsemble(nn.Module):
    """Farklı seed'lerle eğitilmiş TFT'lerin quantile ortalaması — tek bir
    modelin başlangıç ağırlıklarından gelen oynaklığı azaltır."""

    def __init__(self, members: list[TemporalFusionTransformer]):
        super().__init__()
        self.members = nn.ModuleList(members)

    def forward(self, *inputs):
        return torch.stack([m(*inputs)[0] for m in self.members]).mean(0), None


def build_model(n_zones: int, config: TFTConfig) -> nn.Module:
    n_past, n_future = len(config.past_vars()), len(config.future_vars())
    if config.arch == "tft":
        return TemporalFusionTransformer(
            n_zones=n_zones, n_past=n_past, n_future=n_future, d=config.d_model, n_heads=config.n_heads, dropout=config.dropout
        )
    common = dict(
        n_zones=n_zones, n_past=n_past, n_future=n_future, encoder_steps=ENCODER_STEPS, d=config.d_model, dropout=config.dropout
    )
    if config.arch == "tide":
        return TiDE(**common)
    if config.arch == "tsmixer":
        return TSMixer(**common)
    raise ValueError(f"bilinmeyen mimari: {config.arch}")


def quantile_loss(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    q = torch.tensor(QUANTILES, dtype=pred.dtype, device=pred.device)
    err = target.unsqueeze(-1) - pred
    return torch.maximum(q * err, (q - 1) * err).mean()


# ---------------------------------------------------------------------------
# Veri — düzenli 15dk ızgara (T zaman × Z zone)
# ---------------------------------------------------------------------------


@dataclass
class MallSeries:
    timestamps: pd.DatetimeIndex
    zone_codes: list[str]
    zone_ids: list[int]
    zone_names: list[str]
    zone_types: np.ndarray  # (Z,) int
    scales: np.ndarray  # (Z,) kişi sayısı → % çevrimi için ölçek
    cap_feats: np.ndarray  # (Z, 2) [log ölçek, kapasite var mı]
    occupancy: np.ndarray  # (T, Z) %, enjekte anomaliler DAHİL (ham gözlem)
    injected: np.ndarray  # (T, Z) bool, ground truth
    observed: np.ndarray  # (T, Z) bool, o tick'te gerçekten okuma var mı
    time_feats: np.ndarray  # (T, 6) hour_sin, hour_cos, dow_sin, dow_cos, is_weekend, weather
    event: np.ndarray  # (T, Z) 0/1
    net_flow: np.ndarray  # (T, Z) 100 * (giriş − çıkış) / ölçek
    live_start: int  # REFERENCE_NOW'ın ızgaradaki indeksi


# Canlı pencerenin ne kadar geriye gitmesi gerektiği — `TFTConfig.lag_days`'in
# üst sınırı (şu an sadece 1 gün kullanılıyor, 7 günlük lag denenip elendi).
_MAX_LAG_DAYS = 1


def load_mall_series(engine: Engine, mall) -> MallSeries:
    """30 günlük geçmiş (`crowd_readings`, REFERENCE_NOW öncesi — hiç enjekte
    anomali içermez) + canlı haftanın TAMAMI (`staged_crowd_readings`, ground
    truth `is_injected_anomaly` ile). `crowd_readings`'in REFERENCE_NOW sonrası
    kısmı staged'in açığa çıkmış kopyası olduğu için alınmıyor."""
    mall_id = int(mall.id)
    ref = REFERENCE_NOW.strftime("%Y-%m-%d %H:%M:%S")
    zones = pd.read_sql(
        f"SELECT id, code, name, zone_type, capacity FROM zones WHERE mall_id = {mall_id} ORDER BY id", engine
    )
    readings = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count, entries, exits, is_injected_anomaly FROM crowd_readings "
        f"WHERE mall_id = {mall_id} AND timestamp < '{ref}' "
        f"UNION ALL SELECT zone_id, timestamp, person_count, entries, exits, is_injected_anomaly FROM staged_crowd_readings "
        f"WHERE mall_id = {mall_id}",
        engine,
        parse_dates=["timestamp"],
    )
    weather = pd.read_sql(
        f"SELECT timestamp, condition FROM weather_readings WHERE mall_id = {mall_id} AND timestamp < '{ref}' "
        f"UNION ALL SELECT timestamp, condition FROM staged_weather_readings WHERE mall_id = {mall_id}",
        engine,
        parse_dates=["timestamp"],
    ).sort_values("timestamp")
    events = pd.read_sql(
        f"SELECT zone_id, start_time FROM events WHERE mall_id = {mall_id} AND zone_id IS NOT NULL",
        engine,
        parse_dates=["start_time"],
    )
    grid = pd.date_range(readings["timestamp"].min(), readings["timestamp"].max(), freq="15min")
    return _build_series(mall, zones, readings, weather, events, grid)


def load_live_window(conn, mall, ts: pd.Timestamp) -> MallSeries:
    """Canlı simülasyon için: SADECE `ts` anını skorlamaya yetecek son
    `ENCODER_STEPS` + en uzun lag kadar geçmiş (`crowd_readings`, açığa çıkmış
    canlı tick'ler dahil). Serinin son indeksi = `ts`."""
    mall_id = int(mall.id)
    start = ts - pd.Timedelta(minutes=15 * (ENCODER_STEPS + STEPS_PER_DAY * _MAX_LAG_DAYS))
    fmt = "%Y-%m-%d %H:%M:%S.%f"  # SQLite'taki saklama biçimiyle AYNI — metin karşılaştırması
    zones = pd.read_sql(
        f"SELECT id, code, name, zone_type, capacity FROM zones WHERE mall_id = {mall_id} ORDER BY id", conn
    )
    readings = pd.read_sql(
        f"SELECT zone_id, timestamp, person_count, entries, exits, is_injected_anomaly FROM crowd_readings "
        f"WHERE mall_id = {mall_id} AND timestamp >= '{start.strftime(fmt)}' AND timestamp <= '{ts.strftime(fmt)}'",
        conn,
        parse_dates=["timestamp"],
    )
    # pencere başlangıcından ÖNCEKİ en son hava durumu da gerekli (merge_asof backward)
    weather = pd.read_sql(
        f"SELECT timestamp, condition FROM weather_readings WHERE mall_id = {mall_id} AND timestamp <= '{ts.strftime(fmt)}' "
        f"ORDER BY timestamp DESC LIMIT {2 + _MAX_LAG_DAYS + 1}",
        conn,
        parse_dates=["timestamp"],
    ).sort_values("timestamp")
    events = pd.read_sql(
        f"SELECT zone_id, start_time FROM events WHERE mall_id = {mall_id} AND zone_id IS NOT NULL "
        f"AND start_time >= '{(start - pd.Timedelta(hours=2)).strftime(fmt)}' "
        f"AND start_time <= '{(ts + pd.Timedelta(hours=1)).strftime(fmt)}'",
        conn,
        parse_dates=["start_time"],
    )
    return _build_series(mall, zones, readings, weather, events, pd.date_range(start, ts, freq="15min"))


def _build_series(mall, zones, readings, weather, events, grid) -> MallSeries:
    config = mall_config_from_row(mall)
    zone_ids = zones["id"].tolist()
    readings["net_flow"] = readings["entries"] - readings["exits"]
    net_flow = (
        readings.pivot_table(index="timestamp", columns="zone_id", values="net_flow", aggfunc="last")
        .reindex(index=grid, columns=zone_ids)
        .fillna(0.0)
    )
    counts = readings.pivot_table(index="timestamp", columns="zone_id", values="person_count", aggfunc="last")
    counts = counts.reindex(index=grid, columns=zone_ids)
    observed = counts.notna().to_numpy()
    counts = counts.ffill().fillna(0.0)
    injected = (
        readings.pivot_table(index="timestamp", columns="zone_id", values="is_injected_anomaly", aggfunc="max")
        .reindex(index=grid, columns=zone_ids)
        .fillna(0)
        .to_numpy()
        .astype(bool)
    )

    # NOT: `capacity or DEFAULT` KULLANMA — pandas'ta eksik capacity NaN (truthy) gelir
    has_cap = zones["capacity"].notna().to_numpy()
    scales = zones["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY).to_numpy(dtype=float)
    occupancy = 100 * counts.to_numpy() / scales

    grid_df = pd.DataFrame({"timestamp": grid})
    weather["weather_mult"] = weather["condition"].map(WEATHER_MULTIPLIER).fillna(1.0)
    weather_mult = pd.merge_asof(grid_df, weather[["timestamp", "weather_mult"]], on="timestamp", direction="backward")
    hours = grid.hour + grid.minute / 60
    dows = grid.dayofweek
    time_feats = np.column_stack(
        [
            np.sin(2 * np.pi * hours / 24),
            np.cos(2 * np.pi * hours / 24),
            np.sin(2 * np.pi * dows / 7),
            np.cos(2 * np.pi * dows / 7),
            np.isin(dows, list(config.weekend_weekdays)).astype(float),
            weather_mult["weather_mult"].fillna(1.0).to_numpy() - 1.0,  # ~[-0.15, 0.25], nötr=0
        ]
    ).astype(np.float32)

    event = np.zeros_like(occupancy, dtype=np.float32)
    col_of = {zid: j for j, zid in enumerate(zone_ids)}
    for _, ev in events.iterrows():
        j = col_of.get(ev["zone_id"])
        if j is not None:
            mask = (grid >= ev["start_time"] + EVENT_WINDOW[0]) & (grid <= ev["start_time"] + EVENT_WINDOW[1])
            event[mask, j] = 1.0

    return MallSeries(
        timestamps=grid,
        zone_codes=zones["code"].tolist(),
        zone_ids=zone_ids,
        zone_names=zones["name"].tolist(),
        zone_types=np.array([max(zone_type_code(t), 0) for t in zones["zone_type"]]),
        scales=scales,
        cap_feats=np.column_stack([np.log(scales) / np.log(600.0), has_cap.astype(float)]).astype(np.float32),
        occupancy=occupancy.astype(np.float32),
        injected=injected,
        observed=observed,
        time_feats=time_feats,
        event=event,
        net_flow=(100 * net_flow.to_numpy() / scales).astype(np.float32),
        live_start=int(grid.searchsorted(pd.Timestamp(REFERENCE_NOW))),
    )


def _batch(series: MallSeries, occ: np.ndarray, t: np.ndarray, z: np.ndarray, config: TFTConfig):
    """(t, z) çiftleri için model girdileri — sütun sırası `config.past_vars()`
    ile aynı. `occ` (T, Z) — eğitimde ham seri, canlı skorlamada anomali olarak
    işaretlenen noktaları temizlenmiş seri."""
    idx = t[:, None] + np.arange(-ENCODER_STEPS, 1)  # (B, L+1) — son sütun hedef adım
    zc = z[:, None]
    steps = [occ[idx, zc] / PCT_SCALE]
    steps += [occ[idx - d * STEPS_PER_DAY, zc] / PCT_SCALE for d in config.lag_days]
    steps.append(series.event[idx, zc])
    if config.use_flow:
        steps.append(series.net_flow[idx, zc] / PCT_SCALE)
    features = np.concatenate([np.stack(steps, axis=-1), series.time_feats[idx]], axis=-1)  # (B, L+1, n_past)
    past = features[:, :-1]
    future = features[:, -1:, 1:]
    y = occ[t, z] / PCT_SCALE
    return (
        torch.from_numpy(past.astype(np.float32)),
        torch.from_numpy(future.astype(np.float32)),
        torch.from_numpy(z.astype(np.int64)),
        torch.from_numpy(series.zone_types[z].astype(np.int64)),
        torch.from_numpy(series.cap_feats[z]),
        torch.from_numpy(np.asarray(y, dtype=np.float32)),
    )


def _train_val_index(
    series: MallSeries, config: TFTConfig
) -> tuple[tuple[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]:
    """Doğrulama penceresi (son `VAL_DAYS` gün) config'ten bağımsız SABİT —
    farklı config'ler aynı doğrulama setinde kıyaslanabilsin diye; sadece
    eğitimin başlangıcı en uzun lag'e göre kayar."""
    first = config.first_index()
    val_start = series.live_start - VAL_DAYS * STEPS_PER_DAY
    n_z = len(series.zone_ids)

    def pairs(t0, t1):
        t, z = np.meshgrid(np.arange(t0, t1), np.arange(n_z), indexing="ij")
        keep = series.observed[t.ravel(), z.ravel()]
        return t.ravel()[keep], z.ravel()[keep]

    return pairs(first, val_start), pairs(val_start, series.live_start)


# ---------------------------------------------------------------------------
# Skor + eşik
# ---------------------------------------------------------------------------


def sorted_quantiles_pct(quantiles: np.ndarray) -> np.ndarray:
    """Quantile'lar sıralı (çaprazlama olmasın) ve doluluk negatif olamayacağı
    için 0'dan kırpılmış, % ölçeğinde."""
    return np.clip(np.sort(quantiles, axis=-1) * PCT_SCALE, 0.0, None)


def anomaly_scores(quantiles: np.ndarray, actual_pct: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """Gerçek değerin medyandan uzaklığı, o taraftaki (q50→q99 veya q01→q50)
    bant genişliğine bölünür. >1 = %98'lik tahmin bandının dışında. Bant
    genişliğine alt sınır: en az 1.5 kişi — gece/küçük zone'larda bant sıfıra
    yaklaşıp tek kişilik gürültünün sonsuz skor üretmesini önler."""
    q = sorted_quantiles_pct(quantiles)
    med = q[:, Q_MED]
    upper = q[:, Q_HI] - med
    lower = med - q[:, Q_LO]
    floor = 100 * 1.5 / scales
    width = np.where(actual_pct >= med, np.maximum(upper, floor), np.maximum(lower, floor))
    return np.abs(actual_pct - med) / width


def _force_inject(person_count: int, scale: float, rng: random.Random) -> tuple[int, int]:
    """synthetic.maybe_inject_anomaly'nin AYNISI, olasılık kontrolü hariç
    (her çağrıda enjekte eder) — eşik kalibrasyonu için. Dönüş: (yeni kişi
    sayısı, giriş−çıkış sayacına eklenen fark) — ikincisi generate_live_week'in
    enjeksiyonda giriş/çıkışa yaptığı AYNI düzeltme."""
    direction_up = rng.random() < ANOMALY_DIRECTION_UP_PROBABILITY
    if not direction_up and person_count < ANOMALY_QUIET_BASELINE_FRACTION * scale:
        direction_up = True
    if direction_up:
        multiplier = rng.uniform(*ANOMALY_MULTIPLIER_RANGE)
        min_floor = round(ANOMALY_MIN_FLOOR_FRACTION * scale)
        spiked = min(max(round(person_count * multiplier), min_floor), round(scale * 2.5))
        return spiked, (spiked // 4 if spiked >= person_count else -((person_count - spiked) // 4))
    dropped = max(0, round(person_count * rng.uniform(*ANOMALY_DROP_MULTIPLIER_RANGE)))
    return dropped, -((person_count - dropped) // 4)


def _choose_threshold(normal_scores: np.ndarray, anomaly_scores_: np.ndarray) -> dict:
    """Canlı prevalansla (ANOMALY_PROBABILITY) ağırlıklandırılmış F1'i en
    yüksek yapan eşik — dengeli (50/50) bir sette F1 seçmek, gerçekte ~%0.5
    olan anomali oranında çok fazla yanlış alarm veren bir eşiğe götürürdü."""
    w_anom = ANOMALY_PROBABILITY * len(normal_scores) / ((1 - ANOMALY_PROBABILITY) * len(anomaly_scores_))
    candidates = np.unique(np.quantile(np.concatenate([normal_scores, anomaly_scores_]), np.linspace(0.5, 0.9999, 800)))
    best = {"threshold": float(candidates[-1]), "f1": -1.0}
    for thr in candidates:
        tp = w_anom * (anomaly_scores_ > thr).sum()
        fn = w_anom * (anomaly_scores_ <= thr).sum()
        fp = float((normal_scores > thr).sum())
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn)
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if f1 > best["f1"]:
            best = {"threshold": float(thr), "f1": f1, "precision": precision, "recall": recall}
    return {k: round(v, 4) for k, v in best.items()}


# ---------------------------------------------------------------------------
# Eğitim / yükleme / canlı skorlama
# ---------------------------------------------------------------------------


def _predict(model: nn.Module, batch, chunk: int = 4096) -> np.ndarray:
    model.eval()
    past, future, z, zt, cap, _ = batch
    out = []
    with torch.no_grad():
        for i in range(0, len(past), chunk):
            s = slice(i, i + chunk)
            q, _ = model(past[s], future[s], z[s], zt[s], cap[s])
            out.append(q.numpy())
    return np.concatenate(out)


def _fit_one(series: MallSeries, config: TFTConfig, seed: int, train_b, val_b) -> tuple[nn.Module, list[float]]:
    torch.manual_seed(seed)
    model = build_model(len(series.zone_ids), config)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    best_loss, best_state, bad_epochs, history = float("inf"), None, 0, []
    n = len(train_b[0])
    for _epoch in range(config.epochs):
        model.train()
        perm = torch.randperm(n)
        for i in range(0, n, config.batch_size):
            idx = perm[i : i + config.batch_size]
            past, future, z, zt, cap, y = (x[idx] for x in train_b)
            optimizer.zero_grad()
            q, _ = model(past, future, z, zt, cap)
            loss = quantile_loss(q, y)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        val_loss = float(quantile_loss(torch.from_numpy(_predict(model, val_b)), val_b[-1]))
        history.append(round(val_loss, 5))
        if val_loss < best_loss - 1e-5:
            best_loss, best_state, bad_epochs = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            bad_epochs += 1
            if bad_epochs >= config.patience:
                break
    model.load_state_dict(best_state)
    model.eval()
    return model, history


# Doğrulama setine eklenen yapay anomalilerin seed'i config'ten bağımsız SABİT —
# farklı config'ler BİREBİR aynı yapay anomalilerle kıyaslansın diye.
_VAL_INJECTION_SEED = 12345


def validation_report(model: nn.Module, series: MallSeries, config: TFTConfig) -> dict:
    """Doğrulama günlerinin (eğitimde görülmeyen) her okuması hem olduğu gibi
    (normal) hem de synthetic.py'nin kuralıyla enjekte edilmiş haliyle
    skorlanır. Eşik ve config seçimi SADECE bu rapora göre yapılır — canlı
    test haftası (38 anomali, küçük ve tek seferlik) ayar için kullanılmaz."""
    _, (t_va, z_va) = _train_val_index(series, config)
    val_b = _batch(series, series.occupancy, t_va, z_va, config)
    val_q = _predict(model, val_b)
    scales = series.scales[z_va]
    val_pct = series.occupancy[t_va, z_va]
    normal = anomaly_scores(val_q, val_pct, scales)
    rng = random.Random(_VAL_INJECTION_SEED)
    counts = np.rint(val_pct * scales / 100).astype(int)
    spiked = np.array([_force_inject(int(c), s, rng) for c, s in zip(counts, scales)], dtype=np.float32)
    spiked_pct = 100 * spiked[:, 0] / scales
    injected_q = val_q
    if config.use_flow:
        # enjeksiyonun giriş/çıkış sayacına etkisi hedef adımın akış girdisine de yansısın
        past, future, *rest = val_b
        future = future.clone()
        future[:, 0, config.future_vars().index("net_flow")] += torch.from_numpy(
            (100 * spiked[:, 1] / scales / PCT_SCALE).astype(np.float32)
        )
        injected_q = _predict(model, (past, future, *rest))
    injected = anomaly_scores(injected_q, spiked_pct, scales)

    w_anom = ANOMALY_PROBABILITY * len(normal) / ((1 - ANOMALY_PROBABILITY) * len(injected))
    y = np.r_[np.zeros(len(normal)), np.ones(len(injected))]
    weights = np.r_[np.ones(len(normal)), np.full(len(injected), w_anom)]
    q = sorted_quantiles_pct(val_q)
    return {
        "val_rows": int(len(t_va)),
        "val_pr_auc_pct": round(100 * float(average_precision_score(y, np.r_[normal, injected], sample_weight=weights)), 2),
        "val_mae_pct": round(float(np.abs(q[:, Q_MED] - val_pct).mean()), 3),
        "val_band_coverage_pct": round(float(100 * ((val_pct >= q[:, Q_LO]) & (val_pct <= q[:, Q_HI])).mean()), 2),
        "threshold": _choose_threshold(normal, injected),
    }


def _augment_history(series: MallSeries, config: TFTConfig, t_tr: np.ndarray, z_tr: np.ndarray):
    """Eğitim çiftlerinden `augment_rate` oranında rastgele (t, z) seçip
    generate_live_week'in yaptığının AYNISINI uygular: t'deki sayı enjekte
    edilir, giriş/çıkış sayacı düzeltilir; t+1'in sayacı (üretici önceki sayıyı
    enjekte edilmiş değer olarak gördüğü için) normale dönüş farkını taşır.
    Dönüş: artırılmış seri + loss'tan çıkarılacak (t, z) maskesi."""
    rng = random.Random(config.seed)
    np_rng = np.random.default_rng(config.seed)
    occ = series.occupancy.copy()
    flow = series.net_flow.copy()
    chosen = np_rng.random(len(t_tr)) < config.augment_rate
    for t, z in zip(t_tr[chosen], z_tr[chosen]):
        scale = series.scales[z]
        count = int(round(occ[t, z] * scale / 100))
        spiked, flow_delta = _force_inject(count, scale, rng)
        occ[t, z] = 100 * spiked / scale
        flow[t, z] += 100 * flow_delta / scale
        if t + 1 < len(occ):
            flow[t + 1, z] += 100 * (count - spiked) / scale
    return replace(series, occupancy=occ, net_flow=flow), chosen


def train(engine: Engine, mall, config: TFTConfig = TFTConfig(), save: bool = True, series: MallSeries | None = None):
    """`config.n_models` > 1 ise her üye farklı seed'le eğitilir, quantile'lar
    ortalanır. Dönüş: (model, meta)."""
    series = series or load_mall_series(engine, mall)
    (t_tr, z_tr), (t_va, z_va) = _train_val_index(series, config)
    train_series = series
    if config.augment_rate > 0:
        train_series, injected_mask = _augment_history(series, config, t_tr, z_tr)
        t_tr, z_tr = t_tr[~injected_mask], z_tr[~injected_mask]
    train_b = _batch(train_series, train_series.occupancy, t_tr, z_tr, config)
    val_b = _batch(series, series.occupancy, t_va, z_va, config)

    members, histories = [], []
    for i in range(config.n_models):
        member, history = _fit_one(series, config, config.seed + i, train_b, val_b)
        members.append(member)
        histories.append(history)
    model = members[0] if config.n_models == 1 else TFTEnsemble(members)

    meta = {
        "config": asdict(config),
        "zone_codes": series.zone_codes,
        "encoder_steps": ENCODER_STEPS,
        "quantiles": list(QUANTILES),
        "epochs_run": [len(h) for h in histories],
        "train_rows": int(len(t_tr)),
        **validation_report(model, series, config),
    }
    if save:
        out_dir = _artifacts_dir(mall.id)
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.glob("model*.pt"):
            old.unlink()
        for i, member in enumerate(members):
            torch.save(member.state_dict(), out_dir / f"model_{i}.pt")
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return model, meta


def load(mall_id: int) -> tuple[nn.Module, dict] | None:
    out_dir = _artifacts_dir(mall_id)
    meta_path = out_dir / "meta.json"
    if not meta_path.exists() or "config" not in (meta := json.loads(meta_path.read_text())):
        return None  # hiç eğitilmemiş ya da eski formatta — yeniden eğitilmeli
    cfg = meta["config"]
    config = TFTConfig(**{**cfg, "lag_days": tuple(cfg["lag_days"])})
    members = []
    for i in range(config.n_models):
        member = build_model(len(meta["zone_codes"]), config)
        member.load_state_dict(torch.load(out_dir / f"model_{i}.pt", weights_only=True))
        member.eval()
        members.append(member)
    return (members[0] if len(members) == 1 else TFTEnsemble(members)), meta


def config_from_meta(meta: dict) -> TFTConfig:
    cfg = meta["config"]
    return TFTConfig(**{**cfg, "lag_days": tuple(cfg["lag_days"])})


def score_live_week(model: nn.Module, meta: dict, series: MallSeries, threshold: float | None = None) -> pd.DataFrame:
    """Canlı haftayı tick tick, SIRAYLA skorlar — simülasyonun gerçekte
    göreceği gibi. Anomali denen bir okuma, sonraki tick'lerin girdisinde
    modelin kendi medyan tahminiyle değiştirilir; aksi halde tek-tick'lik bir
    sıçrama bir sonraki tick'in geçmişine (ve ertesi günün `lag_1d`'sine)
    girip "normale dönüşü" de anomali gibi gösterirdi."""
    if meta["zone_codes"] != series.zone_codes:
        raise ValueError("TFT modeli farklı bir zone listesiyle eğitilmiş — yeniden eğitin")
    config = config_from_meta(meta)
    threshold = meta["threshold"]["threshold"] if threshold is None else threshold
    clean = series.occupancy.copy()
    # Akış girdisi kullanılıyorsa temizleme YAPILMAZ: bir sonraki tick'in
    # giriş/çıkış sayacı GERÇEK (sıçramış) değere göre ölçülüyor — geçmişi
    # tahminle değiştirmek, sayaçla geçmişi birbirine tutarsız yapar.
    clean_flagged = not config.use_flow
    zones = np.arange(len(series.zone_ids))
    rows = []
    for t in range(series.live_start, len(series.timestamps)):
        z = zones[series.observed[t]]
        if len(z) == 0:
            continue
        q = _predict(model, _batch(series, clean, np.full(len(z), t), z, config))
        actual = series.occupancy[t, z]
        scores = anomaly_scores(q, actual, series.scales[z])
        flagged = scores > threshold
        q_pct = sorted_quantiles_pct(q)
        if clean_flagged:
            clean[t, z[flagged]] = q_pct[flagged, Q_MED]
        for k, j in enumerate(z):
            rows.append(
                {
                    "timestamp": series.timestamps[t],
                    "zone_id": series.zone_ids[j],
                    "zone_code": series.zone_codes[j],
                    "zone_name": series.zone_names[j],
                    "occupancy_pct": float(actual[k]),
                    "expected_pct": float(q_pct[k, Q_MED]),
                    "band_low_pct": float(q_pct[k, Q_LO]),
                    "band_high_pct": float(q_pct[k, Q_HI]),
                    "score": float(scores[k]),
                    "is_outlier": bool(flagged[k]),
                    "is_injected_anomaly": bool(series.injected[t, j]),
                }
            )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Canlı simülasyon + API entegrasyonu
# ---------------------------------------------------------------------------

_live_cache: dict[int, tuple[nn.Module, dict]] = {}


def clear_model_cache() -> None:
    _live_cache.clear()


def _live_model(mall_id: int) -> tuple[nn.Module, dict] | None:
    if mall_id not in _live_cache:
        loaded = load(mall_id)
        if loaded is None:
            return None
        _live_cache[mall_id] = loaded
    return _live_cache[mall_id]


def ensure_trained(engine: Engine, mall) -> dict:
    """reset.py için: kayıtlı model yoksa, zone listesi ya da varsayılan
    config değiştiyse eğitir; aksi halde kayıtlı modeli kullanır. Geçmiş veri
    her reset'te AYNI sabit seed'le üretildiği için kayıtlı model geçerli
    kalıyor — her başlangıçta ~2-4 dk'lık yeniden eğitime gerek yok."""
    zone_codes = pd.read_sql(f"SELECT code FROM zones WHERE mall_id = {int(mall.id)} ORDER BY id", engine)["code"].tolist()
    loaded = load(mall.id)
    if loaded is not None and loaded[1]["zone_codes"] == zone_codes and config_from_meta(loaded[1]) == TFTConfig():
        meta = loaded[1]
    else:
        _, meta = train(engine, mall)
    clear_model_cache()
    return meta


def detect_live(db, mall, ts) -> list[dict]:
    """Simülasyonun o tick'i için TFT kararı — `score_live_week` ile AYNI
    skor/eşik, sadece tek bir tick. Model yoksa boş liste."""
    loaded = _live_model(mall.id)
    if loaded is None:
        return []
    model, meta = loaded
    config = config_from_meta(meta)
    series = load_live_window(db.connection(), mall, pd.Timestamp(ts))
    if series.zone_codes != meta["zone_codes"] or len(series.timestamps) <= config.first_index():
        return []
    t = len(series.timestamps) - 1
    z = np.arange(len(series.zone_ids))[series.observed[t]]
    if len(z) == 0:
        return []
    q = _predict(model, _batch(series, series.occupancy, np.full(len(z), t), z, config))
    actual = series.occupancy[t, z]
    scores = anomaly_scores(q, actual, series.scales[z])
    q_pct = sorted_quantiles_pct(q)
    threshold = meta["threshold"]["threshold"]
    return [
        {
            "zone_id": int(series.zone_ids[j]),
            "timestamp": series.timestamps[t].to_pydatetime(),
            "is_outlier": bool(scores[k] > threshold),
            "score": float(scores[k]),
            "expected_pct": float(q_pct[k, Q_MED]),
            "band_low_pct": float(q_pct[k, Q_LO]),
            "band_high_pct": float(q_pct[k, Q_HI]),
        }
        for k, j in enumerate(z)
    ]


def detection_metrics(tp: int, fp: int, fn: int, tn: int) -> dict:
    """Precision/recall/F1 — accuracy, anomali oranı ~%0.5 olduğu için
    yanıltıcı ("hep normal de" bile %99.5 alır), sadece referans olarak."""
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else None
    total = tp + fp + fn + tn

    def pct(x):
        return None if x is None else round(100 * x, 1)

    return {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "true_negatives": tn,
        "precision_pct": pct(precision),
        "recall_pct": pct(recall),
        "f1_pct": pct(f1),
        "accuracy_pct": pct((tp + tn) / total) if total else None,
    }


def live_summary_and_events(db, mall, limit: int = 200) -> tuple[dict, list[dict]]:
    """TFT'nin şimdiye kadar açığa çıkmış tick'lerdeki kararlarını ground
    truth (`crowd_readings.is_injected_anomaly`) ile birleştirir —
    `anomaly._live_check_rows`'un TFT karşılığı."""
    merged = pd.read_sql(
        "SELECT c.timestamp, c.person_count, c.is_injected_anomaly, z.code AS zone_code, z.name AS zone_name, "
        "z.capacity, t.is_outlier, t.score, t.expected_pct, t.band_low_pct, t.band_high_pct "
        "FROM crowd_readings c "
        "JOIN tft_anomaly_detections t ON t.zone_id = c.zone_id AND t.timestamp = c.timestamp "
        "JOIN zones z ON z.id = c.zone_id "
        f"WHERE c.mall_id = {int(mall.id)} AND t.mall_id = {int(mall.id)}",
        db.connection(),
        parse_dates=["timestamp"],
    )
    if merged.empty:
        return detection_metrics(0, 0, 0, 0), []
    y = merged["is_injected_anomaly"].astype(bool)
    p = merged["is_outlier"].astype(bool)
    summary = detection_metrics(int((y & p).sum()), int((~y & p).sum()), int((y & ~p).sum()), int((~y & ~p).sum()))

    merged["occupancy_pct"] = 100 * merged["person_count"] / merged["capacity"].fillna(DEFAULT_SCALE_NO_CAPACITY)
    shown = merged[y | p].sort_values("timestamp", ascending=False).head(limit)
    outcome = {(True, True): "true_positive", (False, True): "false_positive", (True, False): "false_negative"}
    events = [
        {
            "timestamp": row["timestamp"].isoformat(),
            "zone_code": row["zone_code"],
            "zone_name": row["zone_name"],
            "occupancy_pct": round(float(row["occupancy_pct"]), 1),
            "expected_pct": round(float(row["expected_pct"]), 1),
            "band_low_pct": round(float(row["band_low_pct"]), 1),
            "band_high_pct": round(float(row["band_high_pct"]), 1),
            "model_verdict": "anomaly" if row["is_outlier"] else "normal",
            "actual_label": "injected_anomaly" if row["is_injected_anomaly"] else "normal",
            "outcome": outcome[(bool(row["is_injected_anomaly"]), bool(row["is_outlier"]))],
            "score": round(float(row["score"]), 2),
        }
        for _, row in shown.iterrows()
    ]
    return summary, events


# Aynı zone'da bir önceki tick'te ZATEN bir alarm gösterildiyse yenisi bastırılır —
# arka arkadaki iki okuma aynı olay sayılır. SADECE gösterim; tespit kaydını ve
# doğruluk metriklerini etkilemez. Eskiden 60 dk'ydı (IsolationForest aynı durum
# için art arda ~6 tick alarm verdiği için); TFT'de anomaliler tek tick'lik ve
# yanlış alarm haftada birkaç tane — 60 dk, aynı bölgede 30-60 dk arayla olan
# AYRI gerçek anomalileri gizliyordu (bir haftada 2 gerçek anomali bildirilmedi).
ALERT_COOLDOWN_MINUTES = 15


def _anomaly_alert(
    zone_code: str, zone_name: str, occupancy: float, timestamp: str, detection, floor_name: str | None = None
) -> dict:
    """Canlı alarm ile telafi (kaçırılan) alarmın AYNI biçimde olması için tek
    kaynak — istemci ikisini `zone_code + severity + timestamp` ile tekilleştirir."""
    from .risk import occupancy_level

    return {
        "zone_code": zone_code,
        "zone_name": zone_name,
        "floor_name": floor_name,
        "occupancy_pct": occupancy,
        "level": occupancy_level(occupancy),
        "severity": "anomaly",
        "score": round(detection.score, 2),
        "timestamp": timestamp,
        "expected_pct": round(detection.expected_pct, 1),
        "band_low_pct": round(detection.band_low_pct, 1),
        "band_high_pct": round(detection.band_high_pct, 1),
        "direction": "yuksek" if occupancy >= detection.expected_pct else "dusuk",
        "message": (
            f"{zone_name} bölgesinde olağandışı yoğunluk: %{occupancy:.0f} "
            f"(beklenen %{detection.band_low_pct:.0f}–%{detection.band_high_pct:.0f})."
        ),
    }


def anomaly_alerts(db, mall, snapshot: list[dict]) -> list[dict]:
    """Dashboard/bildirim alarmları — simülasyonun bu tick için yazdığı TFT
    kararını okur (modeli yeniden çalıştırmaz). Mesaj, TFT'nin beklenen
    bandını içerir."""
    from .models import TFTAnomalyDetection

    alerts = []
    for zone_data in snapshot:
        zone_id = zone_data.get("zone_id")
        if zone_id is None or zone_data.get("occupancy_pct") is None or not zone_data.get("timestamp"):
            continue
        ts = pd.Timestamp(zone_data["timestamp"])
        detection = (
            db.query(TFTAnomalyDetection)
            .filter(TFTAnomalyDetection.zone_id == zone_id, TFTAnomalyDetection.timestamp == ts)
            .first()
        )
        if detection is None or not detection.is_outlier:
            continue
        already_alerted_recently = (
            db.query(TFTAnomalyDetection.id)
            .filter(
                TFTAnomalyDetection.zone_id == zone_id,
                TFTAnomalyDetection.is_outlier.is_(True),
                TFTAnomalyDetection.timestamp >= ts - pd.Timedelta(minutes=ALERT_COOLDOWN_MINUTES),
                TFTAnomalyDetection.timestamp < ts,
            )
            .first()
            is not None
        )
        if already_alerted_recently:
            continue
        alerts.append(
            _anomaly_alert(
                zone_data["code"],
                zone_data["name"],
                zone_data["occupancy_pct"],
                zone_data["timestamp"],
                detection,
                zone_data.get("floor_name"),
            )
        )
    return alerts


def recent_anomaly_alerts(db, mall, hours: int = 24) -> list[dict]:
    """Son `hours` saatte canlı yayında gösterilmiş olan TÜM anomali alarmları
    — `anomaly_alerts` ile AYNI bekleme kuralı (aynı zone'da 60 dk içinde
    bir önceki anomali varsa gösterilmemişti). WebSocket (yeniden)
    bağlanırken istemciye gönderilir; istemci kopuk kaldığı sürede
    kaçırdıklarını zile ekler."""
    from .models import CrowdReading, TFTAnomalyDetection, Zone

    latest = db.query(func.max(TFTAnomalyDetection.timestamp)).filter(TFTAnomalyDetection.mall_id == mall.id).scalar()
    if latest is None:
        return []
    window_start = pd.Timestamp(latest) - pd.Timedelta(hours=hours)
    cooldown = pd.Timedelta(minutes=ALERT_COOLDOWN_MINUTES)
    rows = (
        db.query(TFTAnomalyDetection, CrowdReading.person_count, Zone)
        .join(
            CrowdReading,
            (CrowdReading.zone_id == TFTAnomalyDetection.zone_id)
            & (CrowdReading.timestamp == TFTAnomalyDetection.timestamp),
        )
        .join(Zone, Zone.id == TFTAnomalyDetection.zone_id)
        .filter(
            TFTAnomalyDetection.mall_id == mall.id,
            TFTAnomalyDetection.is_outlier.is_(True),
            # pencere başından bir bekleme süresi öncesi de gerekli: pencerenin
            # ilk alarmını bastıran bir önceki anomali orada olabilir
            TFTAnomalyDetection.timestamp >= (window_start - cooldown).to_pydatetime(),
        )
        .order_by(TFTAnomalyDetection.timestamp)
        .all()
    )
    last_outlier: dict[int, pd.Timestamp] = {}
    alerts = []
    for detection, person_count, zone in rows:
        ts = pd.Timestamp(detection.timestamp)
        previous = last_outlier.get(zone.id)
        last_outlier[zone.id] = ts
        if ts < window_start or (previous is not None and ts - previous <= cooldown):
            continue
        # `zone_occupancy_snapshot` ile AYNI yuvarlama/ölçek — canlı alarmla birebir aynı değer
        occupancy = round(100 * person_count / (zone.capacity or DEFAULT_SCALE_NO_CAPACITY), 1)
        alerts.append(
            _anomaly_alert(zone.code, zone.name, occupancy, detection.timestamp.isoformat(), detection, zone.floor.name)
        )
    return alerts


def attach_expected_bands(db, mall, snapshot: list[dict]) -> None:
    """Anlık bölge verisine (`zone_occupancy_snapshot`) TFT'nin o tick için
    beklediği değeri, %98'lik bandı ve anomali kararını ekler — kat planı/3D
    detay kartındaki "normal mi?" satırı için. Tek sorgu (N+1 yok). O tick
    için henüz karar yoksa alanlar eklenmez."""
    from .models import TFTAnomalyDetection

    stamps = {pd.Timestamp(z["timestamp"]).to_pydatetime() for z in snapshot if z.get("timestamp")}
    if not stamps:
        return
    rows = (
        db.query(TFTAnomalyDetection)
        .filter(TFTAnomalyDetection.mall_id == mall.id, TFTAnomalyDetection.timestamp.in_(stamps))
        .all()
    )
    by_key = {(r.zone_id, pd.Timestamp(r.timestamp)): r for r in rows}
    for zone in snapshot:
        if not zone.get("timestamp"):
            continue
        row = by_key.get((zone["zone_id"], pd.Timestamp(zone["timestamp"])))
        if row is None:
            continue
        zone["expected_pct"] = round(row.expected_pct, 1)
        zone["band_low_pct"] = round(row.band_low_pct, 1)
        zone["band_high_pct"] = round(row.band_high_pct, 1)
        zone["is_anomaly"] = bool(row.is_outlier)
