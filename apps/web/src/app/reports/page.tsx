"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ALERT_KIND_STYLE } from "@/components/AlertCard";
import { Delta as DeltaBadge } from "@/components/Delta";
import { type AlertCounts, type ComparisonRow, type WeeklyReport, api } from "@/lib/api";
import { useNotifications } from "@/lib/notifications-context";
import { useLiveFetch } from "@/lib/useLiveFetch";

type Report = Extract<WeeklyReport, { available: true }>;

const THIS_COLOR = "#3b82f6"; // bu hafta — uygulamanın vurgu mavisi
const LAST_COLOR = "#94a3b8"; // geçen hafta — arka planda kalan karşılaştırma (kesikli)
const DOW_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

function fmtRange(r: { start: string; end: string }) {
  const f = (iso: string) => new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  return `${f(r.start)} – ${f(r.end)}`;
}

function Delta({ value, goodWhenUp = true }: { value: number | null; goodWhenUp?: boolean }) {
  return <DeltaBadge value={value} against="geçen haftaya göre" goodWhenUp={goodWhenUp} />;
}

function Kpi({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <div className="text-sm text-neutral-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-white tabular-nums">{value}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function sumAlerts(a: AlertCounts) {
  return a.critical + a.warning + (a.increase ?? 0) + (a.decrease ?? 0);
}

function DailyChart({ report }: { report: Report }) {
  const [metric, setMetric] = useState<"pct" | "visitors">("pct");
  const data = report.daily.map((d) => ({
    label: `${d.label.slice(0, 3)} ${new Date(d.date).getDate()}`,
    this: metric === "pct" ? d.this_pct : d.this_visitors,
    last: metric === "pct" ? d.last_pct : d.last_visitors,
  }));
  const fmt = (v: number) => (metric === "pct" ? `%${v.toFixed(0)}` : v.toLocaleString("tr-TR"));
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">Günlük karşılaştırma</h2>
          <p className="mt-0.5 text-xs text-neutral-500">Bu haftanın her günü, geçen haftanın aynı günüyle</p>
        </div>
        <div className="flex rounded-full border border-white/15 p-0.5 text-xs">
          {(
            [
              ["pct", "Ortalama doluluk"],
              ["visitors", "Ziyaretçi"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              onClick={() => setMetric(k)}
              className={`rounded-full px-3 py-1 transition-colors ${metric === k ? "bg-blue-500/20 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} />
          <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
          <Tooltip
            contentStyle={{ background: "#0f1420", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#e5e5e5" }}
            formatter={(v, name) => [typeof v === "number" ? fmt(v) : "—", name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="last" name="Geçen hafta" stroke={LAST_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={false} />
          <Line type="monotone" dataKey="this" name="Bu hafta" stroke={THIS_COLOR} strokeWidth={2} dot={{ r: 4, strokeWidth: 0, fill: THIS_COLOR }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Gün × saat ortalama doluluk — tek renk (mavi) koyudan açığa sıralı ölçek. */
function Heatmap({ report }: { report: Report }) {
  const grid = useMemo(() => {
    const g: (number | null)[][] = Array.from({ length: 7 }, () => Array(24).fill(null));
    for (const c of report.heatmap) g[c.dow][c.hour] = c.pct;
    return g;
  }, [report.heatmap]);
  const max = Math.max(1, ...report.heatmap.map((c) => c.pct));
  const peak = report.heatmap.reduce((a, b) => (b.pct > a.pct ? b : a), report.heatmap[0]);
  // koyu zeminde: düşük = zemine yakın koyu mavi, yüksek = parlak mavi
  const color = (v: number) => `hsl(217 ${45 + 45 * (v / max)}% ${14 + 46 * (v / max)}%)`;
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">Gün × saat yoğunluğu</h2>
          <p className="mt-0.5 text-xs text-neutral-500">Ortalama AVM doluluğu, son ~5 haftanın tamamından</p>
        </div>
        {peak && (
          <span className="text-xs text-neutral-400">
            En yoğun: <span className="text-white">{DOW_SHORT[peak.dow]} {peak.hour}:00</span> · %{peak.pct.toFixed(0)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] gap-[2px]" style={{ gridTemplateColumns: "36px repeat(24, minmax(0, 1fr))" }}>
          {grid.map((row, dow) => (
            <div key={dow} className="contents">
              <div className="pr-2 text-right text-[11px] leading-5 text-neutral-500">{DOW_SHORT[dow]}</div>
              {row.map((v, hour) => (
                <div
                  key={hour}
                  className={`h-5 rounded-[3px] ${peak && peak.dow === dow && peak.hour === hour ? "ring-2 ring-white/80" : ""}`}
                  style={{ background: v == null ? "rgba(255,255,255,0.03)" : color(v) }}
                  title={v == null ? `${DOW_SHORT[dow]} ${hour}:00 · veri yok` : `${DOW_SHORT[dow]} ${hour}:00 · ortalama %${v.toFixed(0)}`}
                />
              ))}
            </div>
          ))}
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-center text-[10px] text-neutral-600">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-neutral-500">
        <span>düşük</span>
        <span className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(to right, ${color(0)}, ${color(max)})` }} />
        <span>yüksek (%{max.toFixed(0)})</span>
      </div>
    </div>
  );
}

function ChangeCell({ row }: { row: ComparisonRow }) {
  if (row.change_pts == null) return <span className="text-neutral-600">—</span>;
  const v = row.change_pts;
  const cls = Math.abs(v) < 0.5 ? "text-neutral-400" : v > 0 ? "text-orange-300" : "text-sky-300";
  return (
    <span className={`tabular-nums ${cls}`}>
      {Math.abs(v) < 0.5 ? "→" : v > 0 ? "↑" : "↓"} {Math.abs(v).toFixed(1)} puan
    </span>
  );
}

type SortKey = "name" | "floor" | "this_pct" | "last_pct" | "change_pts" | "peak_pct";

function ZoneTable({ report }: { report: Report }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "this_pct", desc: true });
  const rows = useMemo(() => {
    const val = (r: Report["zones"][number]) =>
      sort.key === "name" ? r.name : sort.key === "floor" ? r.level_order : (r[sort.key] ?? -Infinity);
    return [...report.zones].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y as string, "tr") : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [report.zones, sort]);
  const th = (key: SortKey, label: string, right = false) => (
    <th className={`px-4 py-2.5 font-medium ${right ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
        className="hover:text-white"
      >
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-white/15 bg-white/[0.05]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/15 text-xs text-neutral-500">
            {th("name", "Bölge")}
            {th("floor", "Kat")}
            {th("this_pct", "Bu hafta", true)}
            {th("last_pct", "Geçen hafta", true)}
            {th("change_pts", "Değişim", true)}
            {th("peak_pct", "Bu haftanın zirvesi", true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-2.5 text-neutral-200">{r.name}</td>
              <td className="px-4 py-2.5 text-neutral-500">{r.floor_name}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-white">{r.this_pct != null ? `%${r.this_pct.toFixed(1)}` : "—"}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-neutral-400">{r.last_pct != null ? `%${r.last_pct.toFixed(1)}` : "—"}</td>
              <td className="px-4 py-2.5 text-right">
                <ChangeCell row={r} />
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-neutral-300">{r.peak_pct != null ? `%${r.peak_pct.toFixed(0)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertSummary({ report }: { report: Report }) {
  const kinds = [
    ["critical", report.alerts.this.critical, report.alerts.last?.critical ?? null],
    ["warning", report.alerts.this.warning, report.alerts.last?.warning ?? null],
    ["increase", report.alerts.this.increase, report.alerts.last?.increase ?? null],
    ["decrease", report.alerts.this.decrease, report.alerts.last?.decrease ?? null],
  ] as const;
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <h2 className="text-sm font-medium text-neutral-200">Uyarılar</h2>
      <p className="mt-0.5 text-xs text-neutral-500">Anomali tespiti yalnızca canlı hafta için var</p>
      <div className="mt-4 space-y-3">
        {kinds.map(([k, now, before]) => {
          const style = ALERT_KIND_STYLE[k];
          const Icon = style.icon;
          const diff = before != null && now != null ? now - before : null;
          return (
            <div key={k} className="flex items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `${style.accent}22` }}>
                <Icon size={14} color={style.accent} />
              </span>
              <span className="flex-1 text-sm text-neutral-300">{style.label}</span>
              <span className="w-10 text-right text-sm font-semibold tabular-nums text-white">{now ?? "—"}</span>
              <span className="w-28 text-right text-xs tabular-nums text-neutral-500">
                {diff == null ? "geçen hafta —" : `geçen hafta ${before} (${diff > 0 ? "+" : ""}${diff})`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FloorComparison({ report }: { report: Report }) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
      <h2 className="text-sm font-medium text-neutral-200">Katlar</h2>
      <p className="mt-0.5 text-xs text-neutral-500">Ortalama doluluk, bu hafta ve geçen hafta</p>
      <div className="mt-4 space-y-3">
        {report.floors.map((f) => (
          <div key={f.level_order}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-300">{f.floor_name}</span>
              <span className="text-xs">
                <span className="tabular-nums text-white">%{f.this_pct?.toFixed(1) ?? "—"}</span> <ChangeCell row={f} />
              </span>
            </div>
            <div className="relative mt-1.5 h-2 rounded-full bg-white/10">
              <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, f.this_pct ?? 0)}%`, background: THIS_COLOR }} />
              {f.last_pct != null && (
                <div className="absolute -inset-y-1 w-0.5 rounded bg-slate-300" style={{ left: `${Math.min(100, f.last_pct)}%` }} title={`Geçen hafta %${f.last_pct.toFixed(1)}`} />
              )}
            </div>
          </div>
        ))}
        <p className="text-[11px] text-neutral-500">mavi çubuk: bu hafta · beyaz çizgi: geçen hafta</p>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  // canlı akışa bağlı: her yeni tick'te (en fazla 5 sn'de bir) rapor yenilenir
  const { data: live } = useNotifications();
  const { data, error } = useLiveFetch(api.weeklyReport, live?.zones[0]?.timestamp);
  const report = data && data.available ? data : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Raporlar</h1>
          <p className="mt-1 text-sm text-neutral-500">Bu hafta ile geçen haftanın karşılaştırması, günlük seyir ve yoğunluk örüntüleri.</p>
        </div>
        {report && (
          <div className="text-right text-xs text-neutral-500">
            <div>
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: THIS_COLOR }} />
              Bu hafta: <span className="text-neutral-300">{fmtRange(report.this_week)}</span>
            </div>
            <div className="mt-0.5">
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: LAST_COLOR }} />
              Geçen hafta: <span className="text-neutral-300">{fmtRange(report.last_week)}</span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      {report && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Toplam ziyaretçi (girişler)" value={report.kpis.visitors.this.toLocaleString("tr-TR")}>
              <Delta value={report.kpis.visitors.change_pct} />
            </Kpi>
            <Kpi
              label="Ortalama doluluk"
              value={report.kpis.avg_occupancy_pct.this != null ? `%${report.kpis.avg_occupancy_pct.this.toFixed(1)}` : "—"}
            >
              <Delta value={report.kpis.avg_occupancy_pct.change_pct} />
            </Kpi>
            <Kpi
              label="Haftanın zirvesi"
              value={report.kpis.peak ? `%${report.kpis.peak.pct.toFixed(0)}` : "—"}
            >
              {report.kpis.peak && (
                <span className="text-xs text-neutral-400">
                  {new Date(report.kpis.peak.timestamp).toLocaleString("tr-TR", { weekday: "long", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </Kpi>
            <Kpi label="Uyarılar" value={String(sumAlerts(report.alerts.this))}>
              {report.alerts.last ? (
                <Delta
                  value={
                    report.alerts.last.critical + report.alerts.last.warning
                      ? (100 *
                          (report.alerts.this.critical +
                            report.alerts.this.warning -
                            (report.alerts.last.critical + report.alerts.last.warning))) /
                        (report.alerts.last.critical + report.alerts.last.warning)
                      : null
                  }
                  goodWhenUp={false}
                />
              ) : null}
            </Kpi>
          </div>
          <p className="-mt-2 text-[11px] text-neutral-500">
            Uyarı değişimi yalnızca kapasite uyarılarıyla (kritik + yüksek) kıyaslanır — geçen hafta için anomali verisi yok.
          </p>

          <DailyChart report={report} />

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Heatmap report={report} />
            </div>
            <AlertSummary report={report} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <FloorComparison report={report} />
            <div className="lg:col-span-2">
              <ZoneTable report={report} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
