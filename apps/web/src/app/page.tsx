"use client";

import { Bell, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ALERT_KIND_STYLE, AlertCard, type AlertKind, KIND_RANK, alertKind, notificationHref } from "@/components/AlertCard";
import { useNotifications, type NotificationItem } from "@/lib/notifications-context";
import { FloorOverview, summarizeFloors } from "@/components/FloorOverview";
import { LEVEL_BADGE_CLASS, LEVEL_BAR_CLASS, LEVEL_LABEL } from "@/lib/level";
import { type DashboardCompare, api } from "@/lib/api";
import { useConnectionError } from "@/lib/useConnectionError";
import { usePolling } from "@/lib/usePolling";

// Faz 8.42: 4'ten 3'e düşürüldü — bir anda çok sayıda alarm geldiğinde
// (ör. hızlandırılmış simülasyon) ekranın büyük bir kısmını kaplayıp
// "donmuş/tıkanmış" bir izlenim veriyordu.
const MAX_VISIBLE_TOASTS = 3;

// Faz 8.44: zil listesinin KENDİSİ artık `notifications-context.tsx`'te
// (`MAX_STORED_PER_MALL`) en fazla son 10 satırla sınırlı — rozet
// (`totalCount`) ise bundan bağımsız, sınırsız büyüyebiliyor. "+N bildirim
// daha" metni `totalCount - notifications.length` farkından hesaplanıyor.

function AlertsBell({
  notifications,
  totalCount,
  unreadCount,
  onMarkAllRead,
  open,
  onOpenChange,
}: {
  notifications: NotificationItem[];
  totalCount: number;
  unreadCount: number;
  onMarkAllRead: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onOpenChange(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenChange]);

  // Rozet rengi sadece OKUNMAMIŞ bildirimlerin en önemlisine göre
  const topKind = notifications.reduce<AlertKind | null>((top, n) => {
    if (n.read) return top;
    const kind = alertKind(n.alert);
    return !top || KIND_RANK[kind] > KIND_RANK[top] ? kind : top;
  }, null);
  const badgeClass = topKind ? ALERT_KIND_STYLE[topKind].dot : "";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="Bildirimler"
        className={`relative flex items-center justify-center h-8 w-8 rounded-full border transition-colors ${
          unreadCount > 0
            ? "border-white/20 text-white hover:bg-white/10"
            : "border-white/10 text-neutral-500 hover:bg-white/5"
        }`}
      >
        <Bell size={16} strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span
            className={`absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-4 font-semibold text-white flex items-center justify-center ${badgeClass || "bg-blue-500"}`}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[340px] max-h-[420px] overflow-y-auto rounded-xl border border-white/15 bg-[#0f1420] shadow-xl z-20">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-[#0f1420] px-4 py-2.5">
            <span className="text-xs font-medium text-neutral-300">
              Bildirimler{unreadCount > 0 && <span className="ml-1.5 text-neutral-500">({unreadCount} okunmamış)</span>}
            </span>
            <button
              type="button"
              onClick={onMarkAllRead}
              disabled={unreadCount === 0}
              className="text-xs text-blue-400 hover:text-blue-300 disabled:text-neutral-600 disabled:cursor-default transition-colors"
            >
              Tümünü okundu işaretle
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="px-4 py-6 text-sm text-neutral-500 text-center">Henüz bildirim yok.</div>
          ) : (
            <>
              <div className="divide-y divide-white/5">
                {notifications.map((n) => (
                  <Link
                    key={n.id}
                    href={notificationHref(n.alert)}
                    onClick={() => onOpenChange(false)}
                    className="block hover:bg-white/[0.04] transition-colors"
                  >
                    <AlertCard alert={n.alert} unread={!n.read} dimmed={n.read} />
                  </Link>
                ))}
              </div>
              <Link
                href="/notifications"
                onClick={() => onOpenChange(false)}
                className="block border-t border-white/10 px-4 py-2.5 text-center text-xs text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
              >
                {totalCount > notifications.length
                  ? `+${totalCount - notifications.length} bildirim daha`
                  : "Tüm bildirimleri gör"}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AlertsToaster({
  toasts,
  onDismiss,
  paused,
}: {
  toasts: NotificationItem[];
  onDismiss: (id: string) => void;
  paused: boolean;
}) {
  // Bildirim dropdown'u zaten açıkken (aynı uyarıları orada gösteriyorken)
  // toast'lar da görünürse sağ üstte ikisi üst üste biner — dropdown açıkken
  // toast katmanını tamamen gizliyoruz.
  if (paused || toasts.length === 0) return null;

  // Bir anda çok sayıda olay olursa (ör. genel doluluk fırlayıp birçok bölge
  // eşiği aynı anda geçince) toast'lar sınırsız yığılıp ekranın çoğunu
  // kaplayabiliyordu — bunun yerine en fazla `MAX_VISIBLE_TOASTS` kadarı
  // (en YENİleri) gösteriliyor, gerisi "+N daha" ile özetleniyor. Zaten
  // her toast kendi 4sn'lik zamanlayıcısıyla otomatik kayboluyor — eskiler
  // sırayla düşünce, önceden gizli kalanlar doğal olarak görünür hale gelir.
  const visibleToasts = toasts.slice(-MAX_VISIBLE_TOASTS);
  const hiddenCount = toasts.length - visibleToasts.length;

  return (
    <div className="fixed top-20 right-6 z-50 flex flex-col gap-2 w-[380px] max-w-[calc(100vw-3rem)]">
      {visibleToasts.map((t) => (
        <div
          key={t.id}
          className="relative rounded-xl overflow-hidden border border-white/15 shadow-2xl bg-[#0f1420] animate-[toast-in_0.25s_ease-out]"
        >
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Bildirimi kapat"
            className="absolute top-2 right-2 z-10 text-neutral-500 hover:text-white transition-colors"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <Link href={notificationHref(t.alert)} onClick={() => onDismiss(t.id)} className="block pr-5 hover:bg-white/[0.04] transition-colors">
            <AlertCard alert={t.alert} />
          </Link>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="rounded-xl border border-white/15 bg-[#0f1420] px-4 py-2 text-center text-xs text-neutral-400 shadow-2xl">
          +{hiddenCount} bildirim daha
        </div>
      )}
    </div>
  );
}

/** Dashboard KPI kartı — Raporlar'daki kartlarla aynı dil: etiket, büyük değer,
 * altında bağlam ve değişim rozeti; isteğe bağlı küçük görsel (eğri vb.). */
const arrow = (next: number, now: number) => (next - now > 2 ? "↑" : next - now < -2 ? "↓" : "→");
// "Saatlik Değişim" kartıyla aynı renkler: artış turuncu, azalış mavi, sabit nötr
const trendClass = (next: number, now: number) =>
  next - now > 2 ? "text-orange-300" : next - now < -2 ? "text-sky-300" : "text-neutral-300";

function KpiCard({
  label,
  value,
  sub,
  textValue = false,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  /** değer bir ad (kat/bölge) — sayı yerine yazı; uzun adlar tek satırda kısalır */
  textValue?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="h-full rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <div className="whitespace-nowrap text-sm text-neutral-400">{label}</div>
      <div className="mt-2 flex min-w-0 items-baseline gap-2">
        <span
          title={textValue ? value : undefined}
          className={textValue ? "truncate text-2xl leading-9 font-semibold text-white" : "text-3xl font-semibold tabular-nums text-white"}
        >
          {value}
        </span>
        {sub && <span className="truncate text-xs text-neutral-500">{sub}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/** AVM genel doluluğu — bugün 00:00'dan şu ana gerçekleşen (dolu alan) ve şu
 * andan gün sonuna trend modelinin tahmini (kesikli). Kat eğrileriyle aynı
 * dil: mavi = gerçek, kesikli = tahmin. */
function MallDayChart({ compare }: { compare: Extract<DashboardCompare, { available: true }> }) {
  const start = new Date(compare.day_start).getTime();
  const now = new Date(compare.now).getTime();
  const { today, forecast } = compare.curve;
  type Point = { t: number; actual?: number; actualCount?: number; forecast?: number; forecastCount?: number };
  const points = new Map<number, Point>();
  for (const p of today) points.set(new Date(p.t).getTime(), { t: new Date(p.t).getTime(), actual: p.pct, actualCount: p.count });
  // tahmin çizgisi son gerçek noktadan başlasın, arada boşluk kalmasın
  const last = today.at(-1);
  if (last && forecast.length) Object.assign(points.get(new Date(last.t).getTime())!, { forecast: last.pct, forecastCount: last.count });
  for (const p of forecast) {
    const t = new Date(p.t).getTime();
    points.set(t, { ...points.get(t), t, forecast: p.pct, forecastCount: p.count });
  }
  const people = (n: number) => `${n.toLocaleString("tr-TR")} kişi`;
  const data = [...points.values()].sort((a, b) => a.t - b.t);
  const peak = today.reduce<(typeof today)[number] | null>((a, b) => (!a || b.pct > a.pct ? b : a), null);
  const fPeak = forecast.reduce<(typeof forecast)[number] | null>((a, b) => (!a || b.pct > a.pct ? b : a), null);
  const ticks = Array.from({ length: 9 }, (_, i) => start + i * 3 * 3_600_000);

  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">
            AVM Genel Doluluk
            <span className="ml-2 font-normal text-neutral-400">
              {new Date(start).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", weekday: "long" })}
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            dolu alan: bugün gerçekleşen · kesikli: haftalık trend modelinin tahmini (son 4 haftanın aynı saatine göre)
          </p>
        </div>
        <div className="flex gap-5 text-xs text-neutral-400 tabular-nums">
          {peak && (
            <span>
              Bugünün zirvesi <span className="font-medium text-white">%{peak.pct.toFixed(0)}</span> ({people(peak.count)}) ·{" "}
              {hhmm(new Date(peak.t).getTime())}
            </span>
          )}
          {fPeak && (
            <span>
              Tahmini zirve <span className="font-medium text-white">%{fPeak.pct.toFixed(0)}</span> (~{people(fPeak.count)}) ·{" "}
              {hhmm(new Date(fPeak.t).getTime())}
            </span>
          )}
        </div>
      </div>
      {data.length < 2 ? (
        <div className="flex h-[200px] items-center justify-center text-xs text-neutral-500">Günün verisi birikiyor…</div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="mallFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[start, start + 86_400_000]}
              ticks={ticks}
              tickFormatter={hhmm}
              stroke="rgba(255,255,255,0.4)"
              fontSize={11}
              tickLine={false}
            />
            <YAxis
              stroke="rgba(255,255,255,0.4)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `%${v}`}
              width={44}
              domain={[0, (max: number) => Math.max(20, Math.ceil(max / 10) * 10)]}
            />
            <Tooltip
              contentStyle={{ background: "#0f1420", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "#e5e5e5" }}
              labelFormatter={(v) =>
                `${new Date(Number(v)).toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} ${hhmm(Number(v))}`
              }
              formatter={(v, name, item) => {
                const p = item.payload as Point;
                const count = item.dataKey === "actual" ? p.actualCount : p.forecastCount;
                const pct = typeof v === "number" ? `%${v.toFixed(1)}` : "—";
                return [count != null ? `${pct} · ${item.dataKey === "forecast" ? "~" : ""}${people(count)}` : pct, name];
              }}
            />
            <ReferenceLine x={now} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 3" label={{ value: "şimdi", position: "insideTopRight", fill: "#a3a3a3", fontSize: 10 }} />
            <Area type="monotone" dataKey="actual" name="Gerçekleşen" stroke="#3b82f6" strokeWidth={2} fill="url(#mallFill)" dot={false} activeDot={{ r: 4 }} connectNulls={false} />
            <Line type="monotone" dataKey="forecast" name="Tahmin" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.8} dot={false} activeDot={{ r: 4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Son 1 saatte AVM'deki kişi sayısının net değişimi — "Mevcut Ziyaretçi
 * Sayısı" ile AYNI kaynak (içerideki toplam), yani iki kart birbiriyle tutarlı.
 * ±%3'ten küçük değişim "sabit" sayılır. */
function FlowCard({ compare }: { compare: Extract<DashboardCompare, { available: true }> | null }) {
  const now = compare?.inside.now;
  const before = compare?.inside.hour_ago;
  if (now == null || before == null) return <KpiCard label="Saatlik Değişim" value="—" sub="veri birikiyor" />;
  const diff = now - before;
  const steady = Math.abs(diff) < Math.max(10, before * 0.03);
  const trend = steady
    ? { icon: "→", text: "sabit", cls: "text-neutral-300" }
    : diff > 0
      ? { icon: "↑", text: "artıyor", cls: "text-orange-300" }
      : { icon: "↓", text: "azalıyor", cls: "text-sky-300" };
  return (
    <KpiCard label="Saatlik Değişim" value={`${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff).toLocaleString("tr-TR")}`} sub="kişi">
      <span className="text-xs text-neutral-400 tabular-nums">
        <span className={trend.cls}>
          {trend.icon} {trend.text}
        </span>
        {" · "}1 saat önce {before.toLocaleString("tr-TR")} kişi
      </span>
    </KpiCard>
  );
}

export default function DashboardPage() {
  const [bellOpen, setBellOpen] = useState(false);
  const { data, connected, notifications, totalCount, unreadCount, toasts, markAllRead, dismissToast } = useNotifications();

  const connectionError = useConnectionError(connected, !!data);
  const { data: timelines } = usePolling(api.floorTimeline, 15000);
  const { data: compareData } = usePolling(api.dashboardCompare, 15000);
  const compare = compareData && compareData.available ? compareData : null;
  const busiestFloor = data
    ? summarizeFloors(data.zones, data.alerts, data.zone_predictions).reduce<ReturnType<typeof summarizeFloors>[number] | null>(
        (top, f) => (!top || f.pct > top.pct ? f : top),
        null,
      )
    : null;
  const busiestZone = data
    ? data.zones.reduce<(typeof data.zones)[number] | null>(
        (top, z) => (z.occupancy_pct != null && (!top || z.occupancy_pct > (top.occupancy_pct ?? -1)) ? z : top),
        null,
      )
    : null;
  const busiestNext = busiestZone ? data?.zone_predictions?.[busiestZone.code]?.predictions.find((p) => p.horizon_minutes === 60) : undefined;
  return (
    <div className="space-y-8">
      <AlertsToaster toasts={toasts} onDismiss={dismissToast} paused={bellOpen} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          <p className="text-sm text-neutral-500 mt-1">Katların anlık yoğunluğu, 1 saat sonrası ve aktif uyarılar — hangi katta sorun var, tek bakışta.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
            {connected ? "Canlı" : "Bağlanıyor..."}
          </span>
          <AlertsBell
            notifications={notifications}
            totalCount={totalCount}
            unreadCount={unreadCount}
            onMarkAllRead={markAllRead}
            open={bellOpen}
            onOpenChange={setBellOpen}
          />
        </div>
      </div>

      {connectionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Backend&apos;e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Mevcut Ziyaretçi Sayısı"
              // kişi sayısı ve doluluk aynı kaynaktan — farklı anlara ait olmasınlar
              value={(compare?.inside.now ?? data.total_visitors).toLocaleString("tr-TR")}
              sub={`kişi · %${(compare ? (compare.occupancy_pct.now ?? 0) : data.overall_occupancy_pct).toFixed(0)} doluluk`}
            >
              {/* doluluğun paydası: bölge kapasitelerinin toplamı (tanımsızlar için referans ölçek) */}
              <span
                className="text-xs text-neutral-400 tabular-nums"
                title="Bölge kapasitelerinin toplamı. Kapasitesi tanımsız giriş ve yürüyen merdiven için 180 kişilik referans kullanılır."
              >
                AVM kapasitesi {data.total_capacity.toLocaleString("tr-TR")} kişi
              </span>
            </KpiCard>

            <FlowCard compare={compare} />

            <KpiCard label="En yoğun kat" value={busiestFloor?.name ?? "—"} textValue>
              {busiestFloor && (
                <div className="space-y-0.5 text-xs text-neutral-400 tabular-nums">
                  <div>
                    <span className="font-medium text-neutral-200">%{busiestFloor.pct.toFixed(0)}</span> doluluk
                  </div>
                  {busiestFloor.nextHourPct != null && (
                    <div className={trendClass(busiestFloor.nextHourPct, busiestFloor.pct)}>
                      {arrow(busiestFloor.nextHourPct, busiestFloor.pct)} 1 saat sonra %{busiestFloor.nextHourPct.toFixed(0)}
                    </div>
                  )}
                </div>
              )}
            </KpiCard>

            <Link href={busiestZone ? `/live-map?zone=${busiestZone.code}` : "/live-map"} className="block transition-opacity hover:opacity-90">
              <KpiCard label="En yoğun bölge" value={busiestZone?.name ?? "—"} textValue>
                {busiestZone?.occupancy_pct != null && (
                  <div className="space-y-0.5 text-xs text-neutral-400 tabular-nums">
                    <div className="truncate">
                      <span className="font-medium text-neutral-200">%{busiestZone.occupancy_pct.toFixed(0)}</span> doluluk ·{" "}
                      {busiestZone.floor_name}
                    </div>
                    {busiestNext && (
                      <div className={trendClass(busiestNext.predicted_occupancy_pct, busiestZone.occupancy_pct)}>
                        {arrow(busiestNext.predicted_occupancy_pct, busiestZone.occupancy_pct)} 1 saat sonra %
                        {busiestNext.predicted_occupancy_pct.toFixed(0)}
                      </div>
                    )}
                  </div>
                )}
              </KpiCard>
            </Link>
          </div>

          {compare && <MallDayChart compare={compare} />}

          <div>
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-medium text-neutral-300">Kat Bazında Yoğunluk</h2>
              <span className="text-[11px] text-neutral-500">
                eğri: bugün gerçekleşen · kesikli: gün sonuna kadar tahmin — kata tıkla, planı aç
              </span>
            </div>
            <FloorOverview
              zones={data.zones}
              alerts={data.alerts}
              predictions={data.zone_predictions}
              timelines={timelines ?? undefined}
            />
          </div>

          <div>
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-medium text-neutral-300">Bölge Bazında Doluluk</h2>
              <span className="text-[11px] text-neutral-500">en yoğundan başlayarak — bölgeye tıkla, haritada aç</span>
            </div>
            <div className="rounded-xl border border-white/15 bg-white/[0.05] divide-y divide-white/5">
              {data.zones
                .slice()
                .sort((a, b) => (b.occupancy_pct ?? 0) - (a.occupancy_pct ?? 0))
                .map((zone) => {
                  const next = data.zone_predictions?.[zone.code]?.predictions.find((p) => p.horizon_minutes === 60);
                  const delta = next && zone.occupancy_pct != null ? next.predicted_occupancy_pct - zone.occupancy_pct : 0;
                  return (
                    <Link
                      key={zone.code}
                      href={`/live-map?zone=${zone.code}`}
                      className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-white/[0.03]"
                    >
                      <div className="w-44 shrink-0">
                        <div className="text-sm text-neutral-200">{zone.name}</div>
                        <div className="text-[11px] text-neutral-500">{zone.floor_name}</div>
                      </div>
                      <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${zone.level ? LEVEL_BAR_CLASS[zone.level] : "bg-neutral-700"}`}
                          style={{ width: `${Math.min(100, zone.occupancy_pct ?? 0)}%` }}
                        />
                      </div>
                      <div className="w-12 text-right text-sm text-neutral-200 tabular-nums">
                        {zone.occupancy_pct != null ? `%${zone.occupancy_pct.toFixed(0)}` : "-"}
                      </div>
                      <div className="hidden w-28 text-xs text-neutral-400 tabular-nums sm:block" title="Kısa vadeli tahmine göre 1 saat sonra">
                        {next ? (
                          <>
                            <span className={delta > 2 ? "text-orange-300" : delta < -2 ? "text-sky-300" : "text-neutral-300"}>
                              {Math.abs(delta) < 2 ? "→" : delta > 0 ? "↑" : "↓"}
                            </span>{" "}
                            1 sa sonra %{next.predicted_occupancy_pct.toFixed(0)}
                          </>
                        ) : null}
                      </div>
                      {zone.level && (
                        <span className={`w-20 shrink-0 text-center text-xs px-2 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[zone.level]}`}>
                          {LEVEL_LABEL[zone.level]}
                        </span>
                      )}
                    </Link>
                  );
                })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
