"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { FloorPlan2D } from "@/components/FloorPlan2D";
import { ZoneDetailCard } from "@/components/ZoneDetailCard";
import { type ZoneOccupancy } from "@/lib/api";
import { LEVEL_BADGE_CLASS, LEVEL_HEX, LEVEL_LABEL } from "@/lib/level";
import { buildFloorPlans } from "@/lib/mall-layout";
import { useMall } from "@/lib/mall-context";
import { useNotifications } from "@/lib/notifications-context";
import { useConnectionError } from "@/lib/useConnectionError";
import { useStoresByZone } from "@/lib/useStoresByZone";

function LiveMapContent() {
  const { data, connected } = useNotifications();
  const { mallSlug } = useMall();
  const zones = data?.zones as ZoneOccupancy[] | undefined;
  const connectionError = useConnectionError(connected, !!data);
  const storesByZone = useStoresByZone();

  const plans = useMemo(() => (zones ? buildFloorPlans(mallSlug, zones) : []), [mallSlug, zones]);
  const anomalyCodes = useMemo(
    () => new Set((data?.alerts ?? []).filter((a) => a.severity === "anomaly").map((a) => a.zone_code)),
    [data?.alerts],
  );

  // Varsayılan: Zemin Kat (yoksa en alt kat). Seçim AVM değişince geçersizse yine varsayılana düşer.
  // `?floor=N` ile gelindiyse (ör. Dashboard'daki kat satırından) o kat açık başlar.
  const searchParams = useSearchParams();
  const [floorChoice, setFloorChoice] = useState<number | null>(() => {
    const f = searchParams.get("floor");
    return f !== null && !Number.isNaN(Number(f)) ? Number(f) : null;
  });
  // `?zone=KOD` ile gelindiyse (ör. Bildirimler sayfasından) o bölge seçili ve katı açık başlar.
  const [selected, setSelected] = useState<string | null>(() => searchParams.get("zone"));
  const selectedFloor = zones?.find((z) => z.code === selected)?.floor_level_order;
  const defaultFloor =
    selectedFloor ?? plans.find((p) => p.levelOrder === 0)?.levelOrder ?? plans[0]?.levelOrder;
  const activeLevel = plans.some((p) => p.levelOrder === floorChoice) ? floorChoice! : defaultFloor;
  const plan = plans.find((p) => p.levelOrder === activeLevel);

  const selectedZone = zones?.find((z) => z.code === selected) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Canlı Harita</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Kat planı üzerinde canlı yoğunluk — renk doluluk seviyesi, noktalar kalabalığın yoğunluğu. 3D Görünüm ile
            aynı plan.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500 shrink-0 mt-1">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
          {connected ? "Canlı" : "Bağlanıyor..."}
        </span>
      </div>

      {connectionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Backend&apos;e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)
        </div>
      )}

      {plan && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {[...plans].reverse().map((p) => (
              <button
                key={p.levelOrder}
                type="button"
                onClick={() => {
                  setFloorChoice(p.levelOrder);
                  setSelected(null);
                }}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  p.levelOrder === activeLevel
                    ? "border-blue-500/50 bg-blue-500/15 text-white"
                    : "border-white/15 text-neutral-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="relative rounded-xl border border-white/15 bg-white/[0.03] p-4">
            <FloorPlan2D plan={plan} selected={selected} anomalyCodes={anomalyCodes} onSelect={setSelected} />
            {selectedZone && (
              <ZoneDetailCard
                zone={selectedZone}
                anomaly={anomalyCodes.has(selectedZone.code)}
                prediction={data?.zone_predictions?.[selectedZone.code]}
                stores={storesByZone[selectedZone.code]}
                onClose={() => setSelected(null)}
                className="absolute top-3 right-3 w-72"
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-500">
            {(Object.keys(LEVEL_LABEL) as (keyof typeof LEVEL_LABEL)[]).map((level) => (
              <span key={level} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEVEL_HEX[level] }} />
                {LEVEL_LABEL[level]}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-zinc-800 border border-zinc-700" />
              İzlenmeyen mağaza
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border-2 border-blue-500" />
              Anomali
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-sky-300" />
              Vitrin / cam cephe
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {plan.units
              .filter((u) => u.zone)
              .map(({ zone }) => (
                <button
                  key={zone!.code}
                  type="button"
                  onClick={() => setSelected(zone!.code === selected ? null : zone!.code)}
                  className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                    zone!.code === selected ? "border-white/40 bg-white/[0.08]" : "border-white/15 bg-white/[0.04] hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-neutral-200 truncate">{zone!.name}</span>
                    {zone!.level && (
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[zone!.level]}`}>
                        {LEVEL_LABEL[zone!.level]}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-white">
                    {zone!.occupancy_pct != null ? `%${zone!.occupancy_pct.toFixed(0)}` : "-"}
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      {zone!.person_count != null ? `${zone!.person_count} ${zone!.zone_type === "parking" ? "araç" : "kişi"}` : ""}
                    </span>
                  </div>
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function LiveMapPage() {
  return (
    <Suspense fallback={null}>
      <LiveMapContent />
    </Suspense>
  );
}
