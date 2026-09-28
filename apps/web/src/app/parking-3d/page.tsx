"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { type ZoneOccupancy } from "@/lib/api";
import { useMall } from "@/lib/mall-context";
import { useNotifications } from "@/lib/notifications-context";
import { useConnectionError } from "@/lib/useConnectionError";
import { useStoresByZone } from "@/lib/useStoresByZone";

const MallBuilding3D = dynamic(
  () => import("@/components/MallBuilding3D").then((m) => m.MallBuilding3D),
  { ssr: false, loading: () => <div className="h-[760px] rounded-xl border border-white/15 bg-white/[0.05]" /> }
);

export default function Parking3DPage() {
  // NOT (Faz 7.96): önceden 15sn'lik REST polling (`usePolling(api.occupancy)`)
  // kullanıyordu — Canlı Harita ise `/ws/live` WebSocket'iyle HER simülasyon
  // tick'inde anında güncelleniyordu. Simülasyon 900x hızda aktığı için 15sn'lik
  // gecikme ~3.75 simüle saate denk geliyordu — iki sayfa aynı anda bakılınca
  // farklı renk/değer gösterebiliyordu (bug değil, bayat veri). Canlı
  // Harita'yla AYNI kaynağa (`/ws/live`) geçirilerek kök sebep giderildi.
  const { data, connected } = useNotifications();
  const { mallSlug, malls } = useMall();
  const mallName = malls.find((m) => m.slug === mallSlug)?.name ?? "AVM";
  const zones = data?.zones as ZoneOccupancy[] | undefined;
  const connectionError = useConnectionError(connected, !!data);
  const storesByZone = useStoresByZone();
  const anomalyCodes = useMemo(
    () => new Set((data?.alerts ?? []).filter((a) => a.severity === "anomaly").map((a) => a.zone_code)),
    [data?.alerts],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">3D Görünüm</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Canlı Harita&apos;daki kat planının 3D hali — sürükleyerek döndür, kaydırarak yakınlaştır, bir bölgeye
          tıklayarak detay gör. Tüm bina görünümünde bir kata tıklayınca o kat açılır (üstündeki katlar gizlenir).
        </p>
      </div>

      {connectionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Backend&apos;e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)
        </div>
      )}

      {zones && (
        <MallBuilding3D
          zones={zones}
          mallSlug={mallSlug}
          anomalyCodes={anomalyCodes}
          predictions={data?.zone_predictions}
          storesByZone={storesByZone}
          mallName={mallName}
        />
      )}
    </div>
  );
}
