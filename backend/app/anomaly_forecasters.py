"""TFT'ye (`anomaly_tft.py`) alternatif, AYNI arayüzlü quantile tahmin
modelleri — anomali çerçevesi (bant, skor, eşik, doğrulama) hiç değişmeden
sadece model değiştirilerek kıyaslanabilsin diye.

Arayüz (TFT ile aynı):
    forward(past (B, L, n_past), future (B, 1, n_future), zone_idx, type_idx, cap (B, 2))
        → (quantiles (B, n_quantiles), None)
`past[..., 0]` gözlenen doluluk, geri kalan sütunlar ile `future` aynı
bilinen değişkenler (lag, seans, saat, gün, hava).
"""

import torch
import torch.nn as nn

from .features import ZONE_TYPES

ZONE_EMB_DIM = 8
TYPE_EMB_DIM = 4
STATIC_DIM = ZONE_EMB_DIM + TYPE_EMB_DIM + 2  # + kapasite özellikleri


class _Static(nn.Module):
    def __init__(self, n_zones: int):
        super().__init__()
        self.zone_emb = nn.Embedding(n_zones, ZONE_EMB_DIM)
        self.type_emb = nn.Embedding(len(ZONE_TYPES), TYPE_EMB_DIM)

    def forward(self, zone_idx, type_idx, cap):
        return torch.cat([self.zone_emb(zone_idx), self.type_emb(type_idx), cap], dim=-1)


class ResidualBlock(nn.Module):
    """TiDE'nin temel yapı taşı: tek gizli katmanlı MLP + lineer atlama + LayerNorm."""

    def __init__(self, d_in: int, d_hidden: int, d_out: int, dropout: float):
        super().__init__()
        self.mlp = nn.Sequential(nn.Linear(d_in, d_hidden), nn.ReLU(), nn.Linear(d_hidden, d_out), nn.Dropout(dropout))
        self.skip = nn.Linear(d_in, d_out)
        self.norm = nn.LayerNorm(d_out)

    def forward(self, x):
        return self.norm(self.mlp(x) + self.skip(x))


class TiDE(nn.Module):
    """Das et al. 2023, "Long-term Forecasting with TiDE: Time-series Dense
    Encoder". Bilinen değişkenler her adımda küçük bir boyuta yansıtılır,
    geçmiş doluluk + yansıtılmış değişkenler + statik bilgi düzleştirilip yoğun
    (MLP) bir encoder/decoder'dan geçer; hedef adımın kendi değişkenleriyle
    "temporal decoder" son çıktıyı üretir. Geçmişten çıktıya global lineer
    atlama bağlantısı var. Horizon=1."""

    def __init__(
        self,
        n_zones: int,
        n_past: int,
        n_future: int,
        encoder_steps: int,
        d: int = 128,
        cov_dim: int = 4,
        decoder_dim: int = 16,
        n_encoder: int = 2,
        n_decoder: int = 2,
        dropout: float = 0.1,
        n_quantiles: int = 5,
    ):
        super().__init__()
        assert n_past == n_future + 1
        self.static = _Static(n_zones)
        self.cov_proj = ResidualBlock(n_future, d, cov_dim, dropout)
        enc_in = encoder_steps + (encoder_steps + 1) * cov_dim + STATIC_DIM
        self.encoder = nn.Sequential(
            ResidualBlock(enc_in, d, d, dropout), *[ResidualBlock(d, d, d, dropout) for _ in range(n_encoder - 1)]
        )
        self.decoder = nn.Sequential(
            *[ResidualBlock(d, d, d, dropout) for _ in range(n_decoder - 1)], ResidualBlock(d, d, decoder_dim, dropout)
        )
        self.temporal_decoder = ResidualBlock(decoder_dim + cov_dim, d // 2, n_quantiles, dropout)
        self.global_skip = nn.Linear(encoder_steps, n_quantiles)

    def forward(self, past, future, zone_idx, type_idx, cap):
        lookback = past[..., 0]
        covariates = self.cov_proj(torch.cat([past[..., 1:], future], dim=1))  # (B, L+1, cov_dim)
        x = torch.cat([lookback, covariates.flatten(1), self.static(zone_idx, type_idx, cap)], dim=-1)
        decoded = self.decoder(self.encoder(x))
        out = self.temporal_decoder(torch.cat([decoded, covariates[:, -1]], dim=-1)) + self.global_skip(lookback)
        return out, None


class MixerBlock(nn.Module):
    """Zaman boyunca (adımlar arası) ve özellik boyunca (kanallar arası)
    sırayla MLP karıştırma, her biri artık bağlantılı."""

    def __init__(self, n_steps: int, d: int, d_ff: int, dropout: float):
        super().__init__()
        self.time_norm = nn.LayerNorm(d)
        self.time_mlp = nn.Sequential(nn.Linear(n_steps, n_steps), nn.ReLU(), nn.Dropout(dropout))
        self.feat_norm = nn.LayerNorm(d)
        self.feat_mlp = nn.Sequential(
            nn.Linear(d, d_ff), nn.ReLU(), nn.Dropout(dropout), nn.Linear(d_ff, d), nn.Dropout(dropout)
        )

    def forward(self, x):  # (B, S, d)
        x = x + self.time_mlp(self.time_norm(x).transpose(1, 2)).transpose(1, 2)
        return x + self.feat_mlp(self.feat_norm(x))


class TSMixer(nn.Module):
    """Chen et al. 2023, "TSMixer: An All-MLP Architecture for Time Series
    Forecasting" — yardımcı değişkenli (TSMixer-Ext) sürümün horizon=1'e
    uyarlaması: orijinal, geçmişi önce horizon uzunluğuna yansıtıyor; H=1'de
    bu zaman karıştırmayı anlamsız kılacağı için geçmiş + hedef adım TEK bir
    L+1 uzunluğunda dizi olarak karıştırılıyor. Hedef adımın gözlenen
    doluluğu 0 ile maskeleniyor (+ maske göstergesi), yani sızıntı yok.
    Statik bilgi her adıma ekleniyor."""

    def __init__(
        self,
        n_zones: int,
        n_past: int,
        n_future: int,
        encoder_steps: int,
        d: int = 64,
        n_blocks: int = 4,
        dropout: float = 0.1,
        n_quantiles: int = 5,
    ):
        super().__init__()
        assert n_past == n_future + 1
        self.static = _Static(n_zones)
        self.in_proj = nn.Linear(n_past + 1 + STATIC_DIM, d)
        self.blocks = nn.Sequential(*[MixerBlock(encoder_steps + 1, d, 2 * d, dropout) for _ in range(n_blocks)])
        self.norm = nn.LayerNorm(d)
        self.head = nn.Linear(d, n_quantiles)
        self.global_skip = nn.Linear(encoder_steps, n_quantiles)

    def forward(self, past, future, zone_idx, type_idx, cap):
        B, L, _ = past.shape
        target_step = torch.cat([torch.zeros_like(future[..., :1]), future], dim=-1)
        seq = torch.cat([past, target_step], dim=1)  # (B, L+1, n_past)
        mask = torch.zeros(B, L + 1, 1, dtype=past.dtype, device=past.device)
        mask[:, -1] = 1.0
        static = self.static(zone_idx, type_idx, cap).unsqueeze(1).expand(-1, L + 1, -1)
        x = self.blocks(self.in_proj(torch.cat([seq, mask, static], dim=-1)))
        return self.head(self.norm(x[:, -1])) + self.global_skip(past[..., 0]), None
