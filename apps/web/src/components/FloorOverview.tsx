"use client";

import Link from "next/link";
import { ALERT_KIND_STYLE, type AlertKind, alertKind } from "@/components/AlertCard";
import type { Alert, FloorTimeline, ZoneOccupancy, ZonePrediction } from "@/lib/api";
import { LEVEL_HEX, LEVEL_LABEL } from "@/lib/level";

// `zone_occupancy_snapshot` ile AYNI ölçek: kapasitesi olmayan bölgeler (giriş,
// yürüyen merdiven) için varsayılan.
const DEFAULT_SCALE = 180;

function levelOf(pct: number): keyof typeof LEVEL_HEX {
  if (pct < 40) return "dusuk";
  if (pct < 65) return "orta";
  if (pct < 85) return "yuksek";
  return "cok_yuksek";
}

type FloorSummary = {
  levelOrder: number;
  name: string;
  isParking: boolean;
  pct: number;
  nextHourPct: number | null;
  freeSpots: number | null;
  zones: ZoneOccupancy[];
  alertCounts: Partial<Record<AlertKind, number>>;
};

export function summarizeFloors(
  zones: ZoneOccupancy[],
  alerts: Alert[],
  predictions: Record<string, ZonePrediction> | undefined,
): FloorSummary[] {
  const byFloor = new Map<number, ZoneOccupancy[]>();
  for (const z of zones) byFloor.set(z.floor_level_order, [...(byFloor.get(z.floor_level_order) ?? []), z]);
  const floorOfZone = new Map(zones.map((z) => [z.code, z.floor_level_order]));

  return [...byFloor.entries()]
    .sort(([a], [b]) => b - a)
    .map(([levelOrder, fz]) => {
      let count = 0;
      let scale = 0;
      let nextCount = 0;
      let nextScale = 0;
      for (const z of fz) {
        const s = z.capacity ?? DEFAULT_SCALE;
        count += z.person_count ?? 0;
        scale += s;
        const p60 = predictions?.[z.code]?.predictions.find((p) => p.horizon_minutes === 60);
        if (p60) {
          nextCount += p60.predicted_count;
          nextScale += s;
        }
      }
      const isParking = fz.every((z) => z.zone_type === "parking");
      const alertCounts: Partial<Record<AlertKind, number>> = {};
      for (const a of alerts) {
        if (floorOfZone.get(a.zone_code) !== levelOrder) continue;
        const k = alertKind(a);
        alertCounts[k] = (alertCounts[k] ?? 0) + 1;
      }
      return {
        levelOrder,
        name: fz[0].floor_name,
        isParking,
        pct: scale ? (100 * count) / scale : 0,
        nextHourPct: nextScale ? (100 * nextCount) / nextScale : null,
        freeSpots: isParking ? fz.reduce((sum, z) => sum + Math.max(0, (z.capacity ?? 0) - (z.person_count ?? 0)), 0) : null,
        zones: [...fz].sort((a, b) => (b.occupancy_pct ?? 0) - (a.occupancy_pct ?? 0)),
        alertCounts,
      };
    });
}

/** Katın bugünkü eğrisi: gerçekleşen (dolu çizgi) + gün sonuna kadar tahmin
 * (kesikli), "şimdi" çizgisiyle. X ekseni günün 00:00–24:00 aralığı. */
function DayCurve({ timeline, color }: { timeline?: FloorTimeline; color: string }) {
  const w = 220;
  const h = 44;
  if (!timeline || timeline.actual.length === 0) return <div style={{ width: w, height: h }} />;
  const start = new Date(timeline.day_start).getTime();
  const day = 24 * 3600 * 1000;
  const all = [...timeline.actual, ...timeline.forecast];
  const max = Math.max(60, ...all.map((p) => p.pct)) * 1.05;
  const x = (t: string) => ((new Date(t).getTime() - start) / day) * w;
  const y = (pct: number) => h - 2 - (pct / max) * (h - 4);
  const path = (pts: { t: string; pct: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"} ${x(p.t).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(" ");
  const last = timeline.actual.at(-1)!;
  const actualPath = path(timeline.actual);
  const forecastPath = timeline.forecast.length ? path([last, ...timeline.forecast]) : "";
  const nowX = x(timeline.now);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-label="Bugünkü doluluk eğrisi">
      {[6, 12, 18].map((hr) => (
        <line key={hr} x1={(hr / 24) * w} x2={(hr / 24) * w} y1={0} y2={h} stroke="rgba(255,255,255,0.06)" />
      ))}
      <path d={`${actualPath} L ${x(last.t)} ${h} L 0 ${h} Z`} fill={color} fillOpacity={0.12} />
      <path d={actualPath} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      {forecastPath && (
        <path d={forecastPath} fill="none" stroke={color} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="3 3" />
      )}
      <line x1={nowX} x2={nowX} y1={0} y2={h} stroke="rgba(255,255,255,0.45)" strokeDasharray="2 2" />
      <circle cx={nowX} cy={y(last.pct)} r={2.6} fill="white" />
    </svg>
  );
}

const BADGE_ORDER: AlertKind[] = ["critical", "warning", "increase", "decrease", "anomaly"];

/** Dashboard'un kat görünümü: bina kesiti gibi katlar üst üste, her satırda
 * katın toplam doluluğu, 1 saat sonrası tahmini, aktif uyarılar, bölgeler ve
 * bugünün eğrisi. Satır → Canlı Harita'da o kat; bölge → o bölge. */
export function FloorOverview({
  zones,
  alerts,
  predictions,
  timelines,
}: {
  zones: ZoneOccupancy[];
  alerts: Alert[];
  predictions?: Record<string, ZonePrediction>;
  timelines?: FloorTimeline[];
}) {
  const floors = summarizeFloors(zones, alerts, predictions);
  return (
    <div className="overflow-hidden rounded-xl border border-white/15 bg-white/[0.04] divide-y divide-white/10">
      {floors.map((f) => {
        const level = levelOf(f.pct);
        const color = LEVEL_HEX[level];
        const delta = f.nextHourPct != null ? f.nextHourPct - f.pct : 0;
        const arrow = f.nextHourPct == null ? null : Math.abs(delta) < 2 ? "→" : delta > 0 ? "↑" : "↓";
        const timeline = timelines?.find((t) => t.level_order === f.levelOrder);
        return (
          <div key={f.levelOrder} className="group relative flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-white/[0.03] lg:flex-row lg:items-center lg:gap-6">
            {/* satırın tamamı katı açar; bölge bağlantıları üstte ayrı tıklanır */}
            <Link href={`/live-map?floor=${f.levelOrder}`} className="absolute inset-0" aria-label={`${f.name} kat planını aç`} />

            <div className="w-36 shrink-0">
              <div className="text-sm font-semibold text-white">{f.name}</div>
              <div className="mt-0.5 text-[11px] text-neutral-500">
                {f.zones.length} bölge{f.freeSpots != null ? ` · 🚗 ${f.freeSpots} boş yer` : ""}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, f.pct)}%`, background: color }} />
                </div>
                <span className="w-12 text-right text-lg font-semibold tabular-nums" style={{ color }}>
                  %{f.pct.toFixed(0)}
                </span>
                <span className="w-28 text-xs text-neutral-400 tabular-nums" title="Kısa vadeli tahmine göre 1 saat sonra">
                  {arrow && f.nextHourPct != null ? (
                    <>
                      <span className={delta > 2 ? "text-orange-300" : delta < -2 ? "text-sky-300" : "text-neutral-300"}>{arrow}</span> 1 sa sonra %
                      {f.nextHourPct.toFixed(0)}
                    </>
                  ) : (
                    "tahmin yok"
                  )}
                </span>
              </div>
              <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
                {f.zones.map((z) => (
                  <Link
                    key={z.code}
                    href={`/live-map?zone=${z.code}`}
                    className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-neutral-300 hover:border-white/30 hover:text-white"
                    title={z.level ? LEVEL_LABEL[z.level] : undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: z.level ? LEVEL_HEX[z.level] : "#71717a" }} />
                    {z.name}
                    <span className="tabular-nums text-neutral-500">%{z.occupancy_pct?.toFixed(0) ?? "-"}</span>
                  </Link>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex w-24 flex-wrap justify-end gap-1">
                {BADGE_ORDER.filter((k) => f.alertCounts[k]).map((k) => {
                  const Icon = ALERT_KIND_STYLE[k].icon;
                  return (
                    <span
                      key={k}
                      title={ALERT_KIND_STYLE[k].label}
                      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                      style={{ background: `${ALERT_KIND_STYLE[k].accent}22`, color: ALERT_KIND_STYLE[k].accent }}
                    >
                      <Icon size={11} strokeWidth={2.2} />
                      {f.alertCounts[k]}
                    </span>
                  );
                })}
              </div>
              <DayCurve timeline={timeline} color={color} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
