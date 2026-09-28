"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type ZonePrediction } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { useNotifications } from "@/lib/notifications-context";
import { LEVEL_BADGE_CLASS, LEVEL_BAR_CLASS, LEVEL_LABEL } from "@/lib/level";
import { useConnectionError } from "@/lib/useConnectionError";

const OUTCOME_LABEL: Record<string, string> = {
  true_positive: "Doğru Yakalandı",
  false_positive: "Yanlış Alarm",
  false_negative: "Kaçırıldı",
};
const OUTCOME_CLASS: Record<string, string> = {
  true_positive: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
  false_positive: "border-amber-500/40 bg-amber-500/15 text-amber-400",
  false_negative: "border-red-500/40 bg-red-500/15 text-red-400",
};

function formatEventTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function LotForecastChart({ prediction }: { prediction: ZonePrediction | null }) {
  if (!prediction) return <div className="mt-3 h-20" />;

  const chartData = [
    { label: "Şimdi", pct: prediction.current_occupancy_pct },
    ...prediction.predictions.map((p) => ({ label: `+${p.horizon_minutes}dk`, pct: p.predicted_occupancy_pct })),
  ];

  return (
    <div className="mt-3 h-20">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" fontSize={9} tickLine={false} axisLine={false} />
          <YAxis hide domain={[0, 100]} />
          <Tooltip
            contentStyle={{ background: "#171717", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
            formatter={(value) => [`%${Number(value).toFixed(0)}`, "Doluluk"]}
            labelStyle={{ color: "#a3a3a3" }}
          />
          <Bar dataKey="pct" fill="#f97316" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ParkingPage() {
  // Faz 8.13: REST polling yerine artık WebSocket yayınından — `live.parking`
  // (bkz. simulation.py `_broadcast_update`, `parking_status` her tick'te
  // hesaplanıp yayına ekleniyor).
  const { data: live, connected } = useNotifications();
  const data = live?.parking ?? null;
  const { data: anomalyData } = usePolling(api.anomalyEvents, 30000);

  const totalCapacity = data ? data.lots.reduce((sum, lot) => sum + (lot.capacity ?? 0), 0) : 0;
  const totalCount = data ? data.lots.reduce((sum, lot) => sum + (lot.person_count ?? 0), 0) : 0;
  const overallPct = totalCapacity > 0 ? Math.round((100 * totalCount) / totalCapacity) : null;

  const parkingZoneCodes = new Set(data?.lots.map((lot) => lot.code) ?? []);
  const parkingEvents = anomalyData?.events.filter((e) => parkingZoneCodes.has(e.zone_code)).slice(0, 8) ?? [];

  const connectionError = useConnectionError(connected, !!data);
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Otopark</h1>
          <p className="text-sm text-neutral-500 mt-1">P1 / P2 / P3 canlı doluluk ve öneri.</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500 shrink-0">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
          {connected ? "Canlı" : "Bağlanıyor..."}
        </span>
      </div>

      {connectionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Backend&apos;e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)
        </div>
      )}

      {data && (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-white/15 bg-white/[0.05] p-4">
              <div className="text-xs text-neutral-500">Toplam Araç</div>
              <div className="mt-1 text-2xl font-semibold text-white">{totalCount}</div>
            </div>
            <div className="rounded-xl border border-white/15 bg-white/[0.05] p-4">
              <div className="text-xs text-neutral-500">Toplam Kapasite</div>
              <div className="mt-1 text-2xl font-semibold text-white">{totalCapacity}</div>
            </div>
            <div className="rounded-xl border border-white/15 bg-white/[0.05] p-4">
              <div className="text-xs text-neutral-500">Genel Doluluk</div>
              <div className="mt-1 text-2xl font-semibold text-white">{overallPct != null ? `%${overallPct}` : "-"}</div>
            </div>
          </div>

          {data.warning && (
            <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-sm text-orange-300">
              🅿️ {data.warning}
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-4">
            {data.lots.map((lot) => {
              const isRecommended = data.recommended?.code === lot.code;
              return (
                <div
                  key={lot.code}
                  className={`rounded-xl border p-5 ${
                    isRecommended ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-white/15 bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-neutral-300">{lot.name}</span>
                    {isRecommended && (
                      <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-400">
                        Önerilen
                      </span>
                    )}
                  </div>

                  <div className="mt-4 h-3 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${lot.level ? LEVEL_BAR_CLASS[lot.level] : "bg-neutral-700"}`}
                      style={{ width: `${Math.min(100, lot.occupancy_pct ?? 0)}%` }}
                    />
                  </div>

                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="text-3xl font-semibold text-white">
                      {lot.occupancy_pct != null ? `%${lot.occupancy_pct.toFixed(0)}` : "-"}
                    </span>
                    {lot.level && (
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[lot.level]}`}>
                        {LEVEL_LABEL[lot.level]}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {lot.person_count != null ? `${lot.person_count} / ${lot.capacity} araç` : "veri yok"}
                  </div>

                  <div className="mt-3 border-t border-white/10 pt-1">
                    <div className="text-xs text-neutral-500">Kısa vadeli tahmin</div>
                    <LotForecastChart prediction={live?.zone_predictions?.[lot.code] ?? null} />
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <h2 className="text-sm font-medium text-neutral-300 mb-3">Otoparktaki Son Anomaliler</h2>
            {parkingEvents.length === 0 ? (
              <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5 text-sm text-neutral-500">
                Henüz otopark bölgelerinde anomali kaydı yok.
              </div>
            ) : (
              <div className="rounded-xl border border-white/15 bg-white/[0.05] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-neutral-500">
                      <th className="px-4 py-2.5 font-medium">Zaman</th>
                      <th className="px-4 py-2.5 font-medium">Bölge</th>
                      <th className="px-4 py-2.5 font-medium">Doluluk</th>
                      <th className="px-4 py-2.5 font-medium">Sonuç</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parkingEvents.map((e, i) => (
                      <tr key={i} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2.5 text-neutral-400">{formatEventTime(e.timestamp)}</td>
                        <td className="px-4 py-2.5 text-neutral-200">{e.zone_name}</td>
                        <td className="px-4 py-2.5 text-neutral-300">%{e.occupancy_pct.toFixed(0)}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${OUTCOME_CLASS[e.outcome]}`}>
                            {OUTCOME_LABEL[e.outcome]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
