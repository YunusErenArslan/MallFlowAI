"use client";

import Link from "next/link";
import type { ZoneOccupancy, ZonePrediction } from "@/lib/api";
import { LEVEL_BADGE_CLASS, LEVEL_HEX, LEVEL_LABEL } from "@/lib/level";

/** Önümüzdeki 60 dakikanın küçük çizgi grafiği (şimdi + 15/30/45/60 dk). */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 96;
  const h = 28;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <path d={`${d} L ${w} ${h} L 0 ${h} Z`} fill={color} fillOpacity={0.15} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[0][0]} cy={pts[0][1]} r={2.2} fill="white" />
    </svg>
  );
}

/** Kat planında (2D) ve 3D Görünüm'de bir bölgeye tıklanınca açılan kart —
 * üç soruyu cevaplar: şimdi nasıl, birazdan ne olacak, normal mi. */
export function ZoneDetailCard({
  zone,
  anomaly,
  prediction,
  stores,
  onClose,
  className = "",
}: {
  zone: ZoneOccupancy;
  anomaly: boolean;
  prediction?: ZonePrediction;
  stores?: string[];
  onClose: () => void;
  className?: string;
}) {
  const isParking = zone.zone_type === "parking";
  const unit = isParking ? "araç" : "kişi";
  const color = zone.level ? LEVEL_HEX[zone.level] : "#94a3b8";
  const pct = zone.occupancy_pct;

  const horizons = [...(prediction?.predictions ?? [])].sort((a, b) => a.horizon_minutes - b.horizon_minutes);
  const trendValues = pct != null && horizons.length ? [pct, ...horizons.map((h) => h.predicted_occupancy_pct)] : null;
  const last = horizons.at(-1);
  const delta = last && pct != null ? last.predicted_occupancy_pct - pct : 0;
  const trend = Math.abs(delta) < 3 ? { icon: "→", text: "sabit" } : delta > 0 ? { icon: "↑", text: "artıyor" } : { icon: "↓", text: "azalıyor" };

  const hasBand = zone.band_low_pct != null && zone.band_high_pct != null && pct != null;
  const bandStatus = !hasBand
    ? null
    : anomaly || zone.is_anomaly
      ? { cls: "text-blue-300", text: "🔵 Olağandışı — beklenen aralığın dışında" }
      : pct! > zone.band_high_pct!
        ? { cls: "text-amber-300", text: "Beklenenden biraz yüksek" }
        : pct! < zone.band_low_pct!
          ? { cls: "text-amber-300", text: "Beklenenden biraz düşük" }
          : { cls: "text-emerald-400", text: "✓ Normal aralıkta" };

  return (
    <div className={`rounded-xl border border-white/15 bg-neutral-950/95 backdrop-blur px-4 py-3 text-xs shadow-2xl ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-white">{zone.name}</div>
          <div className="text-neutral-500">{zone.floor_name}</div>
        </div>
        <button type="button" onClick={onClose} className="text-neutral-500 hover:text-white" aria-label="Kapat">
          ✕
        </button>
      </div>

      {/* şimdi */}
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-semibold leading-none" style={{ color }}>
          %{pct != null ? pct.toFixed(0) : "-"}
        </span>
        {zone.level && (
          <span className={`mb-0.5 px-2 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[zone.level]}`}>{LEVEL_LABEL[zone.level]}</span>
        )}
      </div>
      <div className="mt-1 text-neutral-400">
        {zone.person_count == null
          ? "veri yok"
          : isParking && zone.capacity != null
            ? `Boş yer: ${Math.max(0, zone.capacity - zone.person_count)} / ${zone.capacity}`
            : zone.capacity != null
              ? `${zone.person_count} / ${zone.capacity} ${unit}`
              : `${zone.person_count} ${unit}`}
      </div>

      {/* birazdan */}
      {trendValues && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="flex items-center justify-between text-neutral-500">
            <span>Önümüzdeki 1 saat</span>
            <span className="text-neutral-300">
              {trend.icon} {trend.text}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <Sparkline values={trendValues} color={color} />
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-neutral-400 tabular-nums">
              {horizons.map((h) => (
                <span key={h.horizon_minutes}>
                  {h.horizon_minutes}dk <span className="text-neutral-200">%{h.predicted_occupancy_pct.toFixed(0)}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* normal mi */}
      {hasBand && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="text-neutral-500">
            Beklenen (TFT): <span className="text-neutral-200 tabular-nums">%{zone.band_low_pct!.toFixed(0)}–%{zone.band_high_pct!.toFixed(0)}</span>
          </div>
          <div className={`mt-0.5 ${bandStatus!.cls}`}>{bandStatus!.text}</div>
        </div>
      )}
      {!hasBand && anomaly && <div className="mt-3 text-blue-300">🔵 Şu an olağandışı yoğunluk (anomali)</div>}

      {stores && stores.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-3 text-neutral-400">
          <span className="text-neutral-500">Mağazalar: </span>
          {stores.join(", ")}
        </div>
      )}

      <div className="mt-3 flex gap-4">
        <Link href={`/predictions?zone=${zone.code}`} className="text-blue-400 hover:text-blue-300">
          Tahminler →
        </Link>
        <Link href="/anomalies" className="text-blue-400 hover:text-blue-300">
          Anomaliler →
        </Link>
      </div>
    </div>
  );
}
