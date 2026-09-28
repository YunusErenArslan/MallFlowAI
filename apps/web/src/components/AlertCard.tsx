"use client";

import { Activity, OctagonAlert, TrendingDown, TrendingUp, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Alert } from "@/lib/api";

/** Bildirim türleri — toast ve zil listesi AYNI kartı kullanır. */
export type AlertKind = "increase" | "decrease" | "anomaly" | "critical" | "warning";

type KindStyle = {
  label: string;
  icon: LucideIcon;
  /** vurgu rengi (ikon, etiket, sol şerit, çubuk işaretçisi) */
  accent: string;
  /** rozet noktası (Tailwind sınıfı) */
  dot: string;
};

export const ALERT_KIND_STYLE: Record<AlertKind, KindStyle> = {
  // Anomaliler uygulamanın her yerinde mavi (kat planı/3D vurgusu, 🔵) — artış aynı mavi,
  // azalış aynı soğuk ailede camgöbeği. Sıcak renkler (turuncu/kırmızı) kapasite uyarılarının.
  increase: { label: "Beklenmedik Ziyaretçi Artışı", icon: TrendingUp, accent: "#60a5fa", dot: "bg-blue-500" },
  decrease: { label: "Beklenmedik Ziyaretçi Azalışı", icon: TrendingDown, accent: "#22d3ee", dot: "bg-cyan-500" },
  anomaly: { label: "Olağandışı Yoğunluk", icon: Activity, accent: "#60a5fa", dot: "bg-blue-500" },
  critical: { label: "Kritik Yoğunluk", icon: OctagonAlert, accent: "#f87171", dot: "bg-red-500" },
  warning: { label: "Yüksek Yoğunluk", icon: TriangleAlert, accent: "#fb923c", dot: "bg-orange-500" },
};

// Zil rozetinin rengi için önem sırası — en ciddi okunmamış bildirim belirler.
export const KIND_RANK: Record<AlertKind, number> = { critical: 4, warning: 3, increase: 2, decrease: 2, anomaly: 1 };

/** Bir bildirimin kalıcı kimliği — zil, toast ve Bildirimler sayfası aynı
 * bildirimi bununla eşleştirir (bölge + tür + simüle zaman). */
export function alertId(a: Alert): string {
  return `${a.zone_code}-${a.severity}-${a.timestamp ?? ""}`;
}

/** Bildirimler sayfasında bu bildirime giden bağlantı (sayfa ona kaydırıp vurgular). */
export function notificationHref(a: Alert): string {
  return `/notifications?focus=${encodeURIComponent(alertId(a))}`;
}

export function alertKind(a: Alert): AlertKind {
  if (a.severity === "critical") return "critical";
  if (a.severity === "warning") return "warning";
  if (a.direction === "yuksek") return "increase";
  if (a.direction === "dusuk") return "decrease";
  return "anomaly";
}

/** Uyarının, backend'in gönderdiği SİMÜLE zaman damgasına göre (gerçek saat
 * değil — simülasyon hızlandırılmış aktığı için) oluştuğu an. */
function formatEventTime(timestamp?: string) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** 0–100(+) doluluk çubuğu. Anomalide beklenen bant taralı, kapasite
 * uyarılarında %65/%85 eşik çizgileri; işaretçi gözlenen değer. */
function OccupancyBar({ alert, accent }: { alert: Alert; accent: string }) {
  const max = Math.max(100, alert.occupancy_pct, alert.band_high_pct ?? 0);
  const pos = (v: number) => `${Math.min(100, (100 * v) / max)}%`;
  const hasBand = alert.band_low_pct != null && alert.band_high_pct != null;
  return (
    <div className="relative mt-2 h-1.5 rounded-full bg-white/10">
      {hasBand && (
        <div
          className="absolute inset-y-0 rounded-full bg-white/35"
          style={{ left: pos(alert.band_low_pct!), width: `calc(${pos(alert.band_high_pct!)} - ${pos(alert.band_low_pct!)} + 3px)` }}
          title="Beklenen aralık"
        />
      )}
      {!hasBand &&
        [65, 85].map((t) => <div key={t} className="absolute -inset-y-0.5 w-px bg-white/40" style={{ left: pos(t) }} />)}
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0f1420]"
        style={{ left: pos(alert.occupancy_pct), background: accent }}
      />
    </div>
  );
}

/** Tek bir bildirim — tür etiketi + ikon, bölge ve kat, doluluk yüzdesi ve
 * bağlamı (anomalide beklenene göre fark, kapasitede kişi/kapasite), çubuk. */
export function AlertCard({ alert, unread, dimmed }: { alert: Alert; unread?: boolean; dimmed?: boolean }) {
  const kind = alertKind(alert);
  const style = ALERT_KIND_STYLE[kind];
  const Icon = style.icon;
  const time = formatEventTime(alert.timestamp);
  const isAnomaly = alert.severity === "anomaly";
  const hasBand = alert.band_low_pct != null && alert.band_high_pct != null;

  // Anomalide "beklenenden ne kadar farklı": bandın dışındaki mesafe (yoksa beklenen değere göre)
  let diff: number | null = null;
  if (isAnomaly) {
    if (hasBand) {
      diff =
        alert.occupancy_pct > alert.band_high_pct!
          ? alert.occupancy_pct - alert.band_high_pct!
          : alert.occupancy_pct < alert.band_low_pct!
            ? alert.occupancy_pct - alert.band_low_pct!
            : 0;
    } else if (alert.expected_pct != null) {
      diff = alert.occupancy_pct - alert.expected_pct;
    }
  }

  return (
    <div className={`relative flex gap-3 px-4 py-3 ${dimmed ? "opacity-50" : ""}`}>
      <span className="absolute left-0 inset-y-2 w-[3px] rounded-r" style={{ background: style.accent }} />
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${style.accent}22` }}>
        <Icon size={15} strokeWidth={2} color={style.accent} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: style.accent }}>
            {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" aria-label="okunmamış" />}
            <span className="truncate whitespace-nowrap" title={style.label}>
              {style.label}
            </span>
          </span>
          {time && <span className="shrink-0 text-[10px] text-neutral-500">{time}</span>}
        </div>

        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold text-white">{alert.zone_name}</span>
          {alert.floor_name && <span className="shrink-0 text-[11px] text-neutral-500">{alert.floor_name}</span>}
        </div>

        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-xl font-semibold leading-none text-white tabular-nums">%{alert.occupancy_pct.toFixed(0)}</span>
          <span className="text-xs text-neutral-400">
            {isAnomaly ? (
              <>
                {diff != null && diff !== 0 && (
                  <span style={{ color: style.accent }} className="font-medium">
                    {diff > 0 ? "+" : "−"}
                    {Math.abs(diff).toFixed(0)} puan{" "}
                  </span>
                )}
                {hasBand
                  ? `· beklenen %${alert.band_low_pct!.toFixed(0)}–%${alert.band_high_pct!.toFixed(0)}`
                  : alert.expected_pct != null
                    ? `· beklenen ~%${alert.expected_pct.toFixed(0)}`
                    : "doluluk"}
              </>
            ) : alert.person_count != null && alert.capacity != null ? (
              `doluluk · ${alert.person_count} / ${alert.capacity} kişi`
            ) : (
              "doluluk"
            )}
          </span>
        </div>

        <OccupancyBar alert={alert} accent={style.accent} />
      </div>
    </div>
  );
}
