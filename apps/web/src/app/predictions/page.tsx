"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type ZoneInfo } from "@/lib/api";
import { LEVEL_BADGE_CLASS, LEVEL_LABEL, RISK_BADGE_CLASS, RISK_LABEL } from "@/lib/level";
import { useNotifications } from "@/lib/notifications-context";
import { useConnectionError } from "@/lib/useConnectionError";

function PredictionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedZone = searchParams.get("zone");

  const [zones, setZones] = useState<ZoneInfo[] | null>(null);
  const { data, connected } = useNotifications();

  useEffect(() => {
    api
      .zones()
      .then(setZones)
      .catch(() => setZones([]));
  }, []);

  // NOT (bkz. trend/page.tsx'teki aynı not): seçili zone `?zone=` URL
  // parametresinde tutuluyor, AVM değişince URL'deki eski değer silinmiyor —
  // sidebar'dan AVM değiştirildiğinde bir önceki AVM'nin zone kodu elde
  // kalabilir. Zone listesi gelince bu kod YENİ AVM'de doğrulanıyor, yoksa
  // ilk zone'a düşülüyor — geçersiz kodla API'ye hiç istek atılmıyor.
  const zoneIsValid = !!zones && !!selectedZone && zones.some((z) => z.code === selectedZone);

  useEffect(() => {
    if (!zones || zones.length === 0) return;
    if (zoneIsValid) return;
    router.replace(`/predictions?zone=${zones[0].code}`);
  }, [zones, zoneIsValid, router]);

  // Faz 8.13: artık ayrı bir REST polling yok — tahmin, zaten her tick'te
  // WebSocket yayınına eklenen `zone_predictions`'tan okunuyor (bkz.
  // simulation.py `_broadcast_update`).
  const prediction = zoneIsValid ? data?.zone_predictions?.[selectedZone!] ?? null : null;

  const chartData = prediction
    ? [
        { label: "Şimdi", pct: prediction.current_occupancy_pct },
        ...prediction.predictions.map((p) => ({ label: `+${p.horizon_minutes}dk`, pct: p.predicted_occupancy_pct })),
      ]
    : [];

  const connectionError = useConnectionError(connected, !!prediction);
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Kısa Vadeli Tahminler</h1>
          <p className="text-sm text-neutral-500 mt-1">15 / 30 / 45 / 60 dakika yoğunluk tahmini + risk + öneri.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-neutral-500 shrink-0">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
            {connected ? "Canlı" : "Bağlanıyor..."}
          </span>
          {zones && (
            <select
              value={selectedZone ?? ""}
              onChange={(e) => router.push(`/predictions?zone=${e.target.value}`)}
              className="rounded-lg border border-white/15 bg-white/[0.05] px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
            >
              {zones.map((z) => (
                <option key={z.code} value={z.code} className="bg-neutral-900">
                  {z.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {connectionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Backend&apos;e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)
        </div>
      )}

      {prediction && (
        <>
          <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
            <div className="text-sm text-neutral-400">{prediction.zone_name} — şu an</div>
            <div className="mt-1 text-3xl font-semibold text-white">
              {prediction.current_count} kişi · %{prediction.current_occupancy_pct.toFixed(0)}
            </div>
          </div>

          <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" fontSize={12} />
                <YAxis stroke="rgba(255,255,255,0.4)" fontSize={12} unit="%" />
                <Tooltip
                  contentStyle={{ background: "#171717", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                  formatter={(value) => [`%${Number(value).toFixed(0)}`, "Doluluk"]}
                />
                <Bar dataKey="pct" fill="#f97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
            {prediction.predictions.map((p) => (
              <div key={p.horizon_minutes} className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-neutral-400">+{p.horizon_minutes} dakika</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${RISK_BADGE_CLASS[p.risk]}`}>
                    {RISK_LABEL[p.risk]}
                  </span>
                </div>
                <div className="mt-2 text-2xl font-semibold text-white">
                  {p.predicted_count} kişi · %{p.predicted_occupancy_pct.toFixed(0)}
                </div>
                <span className={`mt-2 inline-block text-xs px-2 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[p.level]}`}>
                  {LEVEL_LABEL[p.level]}
                </span>
                <p className="mt-3 text-sm text-neutral-400 leading-relaxed">{p.explanation}</p>
                {p.recommendations.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-white/15 pt-3">
                    {p.recommendations.map((r) => (
                      <li key={r} className="text-xs text-neutral-300 flex gap-2">
                        <span className="text-orange-400">•</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function PredictionsPage() {
  return (
    <Suspense fallback={null}>
      <PredictionsContent />
    </Suspense>
  );
}
