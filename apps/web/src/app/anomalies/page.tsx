"use client";

import { api, type AnomalyEvent } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function VerdictBadge({ label }: { label: "anomaly" | "normal" }) {
  const isAnomaly = label === "anomaly";
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs ${
        isAnomaly ? "bg-blue-400/10 text-blue-300" : "bg-white/10 text-neutral-400"
      }`}
    >
      {isAnomaly ? "Anomali" : "Normal"}
    </span>
  );
}

function ActualBadge({ label }: { label: "injected_anomaly" | "normal" }) {
  const isReal = label === "injected_anomaly";
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs ${
        isReal ? "bg-amber-400/10 text-amber-300" : "bg-white/10 text-neutral-400"
      }`}
    >
      {isReal ? "Gerçek Anomali" : "Normal"}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: AnomalyEvent["outcome"] }) {
  const config = {
    true_positive: { text: "Doğru Yakalandı", cls: "bg-emerald-400/10 text-emerald-400" },
    false_positive: { text: "Yanlış Alarm", cls: "bg-amber-400/10 text-amber-400" },
    false_negative: { text: "Kaçırıldı", cls: "bg-red-400/10 text-red-400" },
  }[outcome];
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${config.cls}`}>{config.text}</span>;
}

function SummaryCard({ title, value, detail }: { title: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-6">
      <div className="text-sm text-neutral-400">{title}</div>
      <div className="mt-2 text-4xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-xs text-neutral-500">{detail}</div>
    </div>
  );
}

export default function AnomaliesPage() {
  const { data, error } = usePolling(api.anomalyEvents, 15000);
  const summary = data?.summary;
  const events = data?.events ?? [];
  const catchRatePct =
    summary && summary.known_anomalies > 0 ? Math.round((100 * summary.true_positives) / summary.known_anomalies) : null;
  const normalChecked = summary ? summary.true_negatives + summary.false_positives : 0;
  const falseAlarmPct = summary && normalChecked > 0 ? Math.round((100 * summary.false_positives) / normalChecked) : null;
  const falseAlarmVsWeekTotalPct =
    summary && summary.total_week_normal > 0 ? Math.round((100 * summary.false_positives) / summary.total_week_normal) : null;

  const precisionPct = summary?.precision_pct ?? null;
  const f1Pct = summary?.f1_pct ?? null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Anomaliler</h1>
        <p className="text-sm text-neutral-500 mt-1">
          TFT modeli her bölge için o saatte, o koşulda beklenen doluluk bandını tahmin eder; gözlenen değer bandın
          dışına taşarsa anomali der. Aşağıda canlı simülasyondaki gerçek anomaliler ve modelin bunlardan ne kadarını
          yakaladığı var. Bu haftanın toplam anomali sayısı baştan biliniyor, akış ilerledikçe &ldquo;gerçekleşen&rdquo;
          sayı ona doğru artıyor.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {summary && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <SummaryCard
            title="Gerçek Anomali Sayısı"
            value={summary.total_week_anomalies}
            detail={`Bu hafta toplam enjekte edilecek sayı — şimdiye kadar ${summary.known_anomalies} gerçekleşti.`}
          />
          <SummaryCard
            title="Yakalanan"
            value={summary.true_positives}
            detail={
              summary.known_anomalies > 0
                ? `${summary.true_positives}/${summary.known_anomalies} gerçek anomali yakalandı (%${catchRatePct})`
                : "henüz gerçek anomali birikmedi"
            }
          />
          <SummaryCard
            title="Yanlış Alarm"
            value={summary.false_positives}
            detail={
              normalChecked > 0
                ? `${summary.false_positives}/${normalChecked} normal anda alarm (%${falseAlarmPct}) — bu hafta toplam ${summary.total_week_normal} normal an (%${falseAlarmVsWeekTotalPct})`
                : "kontrol edilen normal an yok"
            }
          />
          <SummaryCard
            title="Kaçırılan"
            value={summary.false_negatives}
            detail="Gerçekten anomaliydi ama model normal dedi (false negative)."
          />
          <SummaryCard
            title="F1"
            value={f1Pct === null ? "—" : `%${f1Pct.toFixed(1)}`}
            detail={
              precisionPct === null
                ? "yakalama ile doğru alarm oranının dengesi — henüz alarm yok"
                : `Verilen alarmların %${precisionPct.toFixed(1)}'i gerçek anomali. F1, yakalama ile bu oranın dengesi.`
            }
          />
        </div>
      )}

      {data && events.length === 0 && (
        <div className="rounded-xl border border-white/15 bg-white/[0.05] p-8 text-center text-sm text-neutral-500">
          Henüz kayda değer bir olay yok — gerçek anomali enjekte edilmedi veya model yanlış alarm vermedi.
        </div>
      )}

      {data && events.length > 0 && (
        <div className="rounded-xl border border-white/15 bg-white/[0.05] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/15 text-left text-neutral-500">
                <th className="px-4 py-3 font-medium">Zaman</th>
                <th className="px-4 py-3 font-medium">Bölge</th>
                <th className="px-4 py-3 font-medium">Gözlenen</th>
                <th className="px-4 py-3 font-medium">Beklenen (bant)</th>
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium">Gerçek Durum</th>
                <th className="px-4 py-3 font-medium">Sonuç</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, i) => (
                <tr key={`${event.zone_code}-${event.timestamp}-${i}`} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 text-neutral-400 whitespace-nowrap">{formatTimestamp(event.timestamp)}</td>
                  <td className="px-4 py-3 text-white">{event.zone_name}</td>
                  <td className="px-4 py-3 text-neutral-300 tabular-nums">%{event.occupancy_pct.toFixed(0)}</td>
                  <td className="px-4 py-3 text-neutral-400 tabular-nums whitespace-nowrap">
                    {event.expected_pct == null || event.band_low_pct == null || event.band_high_pct == null
                      ? "—"
                      : `%${event.expected_pct.toFixed(0)} (%${event.band_low_pct.toFixed(0)}–%${event.band_high_pct.toFixed(0)})`}
                  </td>
                  <td className="px-4 py-3">
                    <VerdictBadge label={event.model_verdict} />
                  </td>
                  <td className="px-4 py-3">
                    <ActualBadge label={event.actual_label} />
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeBadge outcome={event.outcome} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
