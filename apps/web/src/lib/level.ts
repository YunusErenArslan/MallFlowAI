import type { OccupancyLevel } from "./api";

export const LEVEL_LABEL: Record<OccupancyLevel, string> = {
  dusuk: "Düşük",
  orta: "Orta",
  yuksek: "Yüksek",
  cok_yuksek: "Çok Yüksek",
};

export const LEVEL_EMOJI: Record<OccupancyLevel, string> = {
  dusuk: "🟢",
  orta: "🟡",
  yuksek: "🟠",
  cok_yuksek: "🔴",
};

export const LEVEL_BADGE_CLASS: Record<OccupancyLevel, string> = {
  dusuk: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  orta: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  yuksek: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  cok_yuksek: "bg-red-500/15 text-red-400 border-red-500/30",
};

export const LEVEL_BAR_CLASS: Record<OccupancyLevel, string> = {
  dusuk: "bg-emerald-500",
  orta: "bg-amber-500",
  yuksek: "bg-orange-500",
  cok_yuksek: "bg-red-500",
};

export const RISK_LABEL: Record<string, string> = {
  low: "Düşük",
  medium: "Orta",
  high: "Yüksek",
  critical: "Kritik",
};

export const RISK_BADGE_CLASS: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  critical: "bg-red-500/15 text-red-400 border-red-500/30",
};

// SVG/3D için ham renkler — Tailwind emerald/amber/orange/red-500, rozet renkleriyle birebir aynı.
export const LEVEL_HEX: Record<OccupancyLevel, string> = {
  dusuk: "#10b981",
  orta: "#f59e0b",
  yuksek: "#f97316",
  cok_yuksek: "#ef4444",
};

// Anomali vurgusu — dashboard'daki 🔵 anomali alarmlarıyla aynı mavi.
export const ANOMALY_HEX = "#3b82f6";
