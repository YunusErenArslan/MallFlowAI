"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FloorPlan2D } from "@/components/FloorPlan2D";
import { ZoneDetailCard } from "@/components/ZoneDetailCard";
import { api, type TrendForecast, type TrendForecastAllZone, type ZoneInfo, type ZoneOccupancy } from "@/lib/api";
import { LEVEL_HEX, LEVEL_LABEL } from "@/lib/level";
import { buildFloorPlans } from "@/lib/mall-layout";
import { useMall } from "@/lib/mall-context";
import { useNotifications } from "@/lib/notifications-context";

function formatTick(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("tr-TR", { weekday: "short" }) + " " + d.getHours() + ":00";
}

type ChartPoint = {
  label: string;
  pct: number;
  predictedCount: number;
  actualPct: number | null;
  actualCount: number | null;
};

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: ChartPoint }[];
  label?: string;
}) {
  if (!active || !payload || !payload.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/15 bg-neutral-900 px-3 py-2 text-sm">
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className="text-blue-400">
        Tahmin: %{point.pct.toFixed(0)} ({point.predictedCount} kişi)
      </div>
      {point.actualPct != null ? (
        <div className="text-emerald-400">
          Gerçekleşen: %{point.actualPct.toFixed(0)} ({point.actualCount} kişi)
        </div>
      ) : (
        <div className="text-neutral-600">Gerçekleşen: henüz yok</div>
      )}
    </div>
  );
}

function formatSliderLabel(iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("tr-TR", { weekday: "long", day: "2-digit", month: "short" });
  return `${day} ${d.getHours().toString().padStart(2, "0")}:00`;
}

const MallBuilding3D = dynamic(() => import("@/components/MallBuilding3D").then((m) => m.MallBuilding3D), {
  ssr: false,
  loading: () => <div className="h-[760px] rounded-xl border border-white/15 bg-white/[0.05]" />,
});

/** Tahmin serisinin `index`'inci anını, Canlı Harita/3D'nin kullandığı bölge
 * biçimine çevirir — böylece aynı kat planı çizimi tahmini doluluğu gösterir.
 * Tahmin uç noktası bölge tipini taşımadığı için tip canlı veriden alınır. */
function forecastZonesAt(
  forecasts: TrendForecastAllZone[],
  index: number,
  zoneTypes: Record<string, string>,
): ZoneOccupancy[] {
  return forecasts.map((z) => {
    const point = z.points[Math.min(index, z.points.length - 1)];
    const pct = point?.predicted_occupancy_pct ?? null;
    return {
      code: z.code,
      name: z.name,
      zone_type: zoneTypes[z.code] ?? "retail",
      floor_code: z.floor_code,
      floor_name: z.floor_name,
      floor_level_order: z.floor_level_order,
      timestamp: point?.target_timestamp,
      person_count: pct != null && z.capacity != null ? Math.round((pct * z.capacity) / 100) : null,
      capacity: z.capacity,
      occupancy_pct: pct,
      level: point?.level ?? null,
    };
  });
}

/** Zaman kaydırıcısındaki an için tahmini doluluğu Canlı Harita'daki kat planı
 * (2D) ve 3D Görünüm ile AYNI plan üzerinde gösterir — `/trend/forecast/all`'dan
 * gelen tüm zone'ların tahmin serisini kullanır. */
function FloorForecastKroki() {
  const [allForecasts, setAllForecasts] = useState<TrendForecastAllZone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [floorChoice, setFloorChoice] = useState<number | null>(null);
  const [timeIndex, setTimeIndex] = useState(0);
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [selected, setSelected] = useState<string | null>(null);
  const { mallSlug, malls } = useMall();
  // Faz 8.13: ayrı bir polling aralığı yok — her WebSocket tick'inde (aynı
  // yayın `dashboard_summary`'yi de güncellediği an) `data` referansı
  // değişiyor, bu da forecast'i canlı akışla senkron şekilde tazeliyor
  // (`trend/forecast/all` ucuz bir DB okuması, ağır model çıkarımı değil).
  const { data: live } = useNotifications();

  useEffect(() => {
    let cancelled = false;
    api
      .trendForecastAll()
      .then((res) => {
        if (!cancelled) setAllForecasts(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const zoneTypes = useMemo(
    () => Object.fromEntries((live?.zones ?? []).map((z) => [z.code, z.zone_type])),
    [live?.zones],
  );
  const maxIndex = allForecasts?.length ? Math.min(...allForecasts.map((z) => z.points.length)) - 1 : 0;
  const clampedIndex = Math.min(timeIndex, Math.max(0, maxIndex));
  const zones = useMemo(
    () => (allForecasts ? forecastZonesAt(allForecasts, clampedIndex, zoneTypes) : []),
    [allForecasts, clampedIndex, zoneTypes],
  );
  const plans = useMemo(() => buildFloorPlans(mallSlug, zones), [mallSlug, zones]);
  const noAnomalies = useMemo(() => new Set<string>(), []);

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
    );
  }
  if (!allForecasts || plans.length === 0) return null;

  const defaultFloor = plans.find((p) => p.levelOrder === 0)?.levelOrder ?? plans[0].levelOrder;
  const activeLevel = plans.some((p) => p.levelOrder === floorChoice) ? floorChoice! : defaultFloor;
  const plan = plans.find((p) => p.levelOrder === activeLevel)!;
  const sliderTime = allForecasts[0]?.points[clampedIndex]?.target_timestamp;
  const selectedZone = zones.find((z) => z.code === selected) ?? null;
  const mallName = malls.find((m) => m.slug === mallSlug)?.name ?? "AVM";

  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">Kat Krokisi — Tahmini Doluluk</h2>
          <p className="text-xs text-neutral-500 mt-1">
            Kaydırıcıdaki an için tahmini doluluk — Canlı Harita ve 3D Görünüm ile aynı kat planı.
          </p>
        </div>
        <div className="flex rounded-full border border-white/15 p-0.5 text-xs">
          {(["2d", "3d"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-full transition-colors ${mode === m ? "bg-blue-500/20 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
          <span>Zaman</span>
          <span className="text-white font-medium">{sliderTime ? formatSliderLabel(sliderTime) : "-"}</span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, maxIndex)}
          value={clampedIndex}
          onChange={(e) => setTimeIndex(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-neutral-600 mt-1">
          <span>Şimdi</span>
          <span>+7 gün</span>
        </div>
      </div>

      {mode === "2d" ? (
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
          <div className="relative rounded-xl border border-white/10 bg-black/20 p-4">
            <FloorPlan2D plan={plan} selected={selected} anomalyCodes={noAnomalies} onSelect={setSelected} />
            {selectedZone && (
              <ZoneDetailCard
                zone={selectedZone}
                anomaly={false}
                onClose={() => setSelected(null)}
                className="absolute top-3 right-3 w-64"
              />
            )}
          </div>
        </>
      ) : (
        <MallBuilding3D zones={zones} mallSlug={mallSlug} anomalyCodes={noAnomalies} mallName={mallName} />
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-500">
        {(Object.keys(LEVEL_LABEL) as (keyof typeof LEVEL_LABEL)[]).map((level) => (
          <span key={level} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEVEL_HEX[level] }} />
            {LEVEL_LABEL[level]}
          </span>
        ))}
        <span>· Noktalar tahmini kalabalık yoğunluğu</span>
      </div>
    </div>
  );
}

function TrendContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedZone = searchParams.get("zone");

  const [zones, setZones] = useState<ZoneInfo[] | null>(null);
  const [forecast, setForecast] = useState<TrendForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: live, connected } = useNotifications();

  useEffect(() => {
    api
      .zones()
      .then(setZones)
      .catch(() => setZones([]));
  }, []);

  // NOT: seçili zone `?zone=` URL parametresinde tutuluyor, AVM değişince
  // sayfa yeniden kurulsa da URL'deki eski değer SİLİNMİYOR — sidebar'dan AVM
  // değiştirildiğinde bir önceki AVM'nin zone kodu (ör. Mall B'nin
  // `B_ENTRANCE`'ı) burada elde kalabilir. Zone listesi gelince bu kodun YENİ
  // AVM'de gerçekten var olup olmadığı doğrulanıyor; yoksa (hem hiç seçim
  // yokken hem de başka bir AVM'ye ait geçersiz bir kod varken) ilk zone'a
  // düşülüyor — geçersiz kodla API'ye hiç istek atılmıyor.
  const zoneIsValid = !!zones && !!selectedZone && zones.some((z) => z.code === selectedZone);

  useEffect(() => {
    if (!zones || zones.length === 0) return;
    if (zoneIsValid) return;
    router.replace(`/trend?zone=${zones[0].code}`);
  }, [zones, zoneIsValid, router]);

  // Faz 8.13: aynı `FloorForecastKroki`'deki gibi — `live` her tick'te
  // değişince (yeni veri açığa çıktığında) yeniden çekiliyor, ayrı bir sabit
  // polling aralığı yok.
  useEffect(() => {
    if (!zoneIsValid) return;
    let cancelled = false;
    api
      .trendForecast(selectedZone!)
      .then((f) => {
        if (!cancelled) {
          setForecast(f);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedZone, zoneIsValid, live]);

  const chartData: ChartPoint[] =
    forecast?.forecast.map((p) => ({
      label: formatTick(p.timestamp),
      pct: p.predicted_occupancy_pct,
      predictedCount: p.predicted_count,
      actualPct: p.actual_occupancy_pct,
      actualCount: p.actual_count,
    })) ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Uzun Vadeli Tahminler</h1>
          <p className="text-sm text-neutral-500 mt-1">
            LSTM (derin öğrenme) — geçmiş 4 haftanın aynı saatlerine (t-7/14/21/28 gün) bakarak önümüzdeki 7 günü
            tahmin eder.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-neutral-500 shrink-0">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
            {connected ? "Canlı" : "Bağlanıyor..."}
          </span>
          {zones && (
            <select
              value={selectedZone ?? ""}
              onChange={(e) => router.push(`/trend?zone=${e.target.value}`)}
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

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error === `API /trend/forecast?zone=${selectedZone} -> HTTP 503`
            ? "Trend modeli henüz eğitilmedi — backend'de `python -m app.train_trend` çalıştırılmalı."
            : error}
        </div>
      )}

      {forecast && (
        <div className="rounded-xl border border-white/15 bg-white/[0.05] p-5">
          <div className="text-sm text-neutral-400 mb-4">{forecast.zone_name} — önümüzdeki 7 gün (saatlik)</div>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" fontSize={10} interval={23} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={12} unit="%" />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="pct" name="Tahmin" stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line
                type="monotone"
                dataKey="actualPct"
                name="Gerçekleşen"
                stroke="#34d399"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <FloorForecastKroki />
    </div>
  );
}

export default function TrendPage() {
  return (
    <Suspense fallback={null}>
      <TrendContent />
    </Suspense>
  );
}
