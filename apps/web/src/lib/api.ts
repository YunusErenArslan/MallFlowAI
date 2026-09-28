const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Faz 8.4: AVM seçici eklendi — artık seçili AVM sabit değil, `mall-context.tsx`
// (MallProvider) kullanıcının seçimine göre `setApiMallSlug()` ile burayı
// günceller. Modül seviyesi değişken (React state DEĞİL) çünkü bu dosyadaki
// `api.*` fonksiyonları düz fonksiyon, hook değil — her çağrıldığında en
// GÜNCEL seçili AVM'yi `mallBase()` ile okuyorlar.
let currentMallSlug = "mall-a";

export function setApiMallSlug(slug: string): void {
  currentMallSlug = slug;
}

function mallBase(): string {
  return `/malls/${currentMallSlug}`;
}

export type MallInfo = {
  slug: string;
  name: string;
  opening_hour: number;
  closing_hour: number;
  zone_count: number;
};

export type OccupancyLevel = "dusuk" | "orta" | "yuksek" | "cok_yuksek";

export type ZoneOccupancy = {
  code: string;
  name: string;
  zone_type: string;
  floor_code: string;
  floor_name: string;
  floor_level_order: number;
  timestamp?: string;
  person_count: number | null;
  capacity: number | null;
  occupancy_pct: number | null;
  level: OccupancyLevel | null;
  // TFT'nin bu tick için beklediği doluluk ve %98'lik bandı (henüz karar yoksa yok)
  expected_pct?: number;
  band_low_pct?: number;
  band_high_pct?: number;
  is_anomaly?: boolean;
};

export type Alert = {
  zone_code: string;
  zone_name: string;
  occupancy_pct: number;
  level: OccupancyLevel;
  severity: "warning" | "critical" | "anomaly";
  message?: string;
  score?: number;
  timestamp?: string;
  // Sadece severity="anomaly" için: aynı bölgenin AYNI saat:dakika +
  // hafta içi/sonu diliminde geçmiş okumalarının düz ortalaması ve gerçek
  // değerle karşılaştırıldığında yön (beklenenden fazla mı az mı) — yeterli
  // geçmiş örnek yoksa ikisi de null.
  expected_pct?: number | null;
  direction?: "yuksek" | "dusuk" | null;
  floor_name?: string | null;
  // anomali: TFT'nin %98'lik beklenen bandı; kapasite uyarısı: kişi / kapasite
  band_low_pct?: number | null;
  band_high_pct?: number | null;
  person_count?: number | null;
  capacity?: number | null;
};

export type DashboardSummary = {
  total_visitors: number;
  total_capacity: number;
  overall_occupancy_pct: number;
  busiest_zone: { code: string; name: string; occupancy_pct: number } | null;
  riskiest_zone: { code: string; name: string; occupancy_pct: number; level: OccupancyLevel } | null;
  zones: ZoneOccupancy[];
  alerts: Alert[];
  // Faz 8.13: her tick'te zaten hesaplanan (bedava) zone tahminleri + otopark
  // durumu — "Kısa Vadeli Tahminler"/"Otopark" sayfaları artık REST polling
  // yerine bu WebSocket yayınını dinliyor. `zone_code -> ZonePrediction`.
  zone_predictions?: Record<string, ZonePrediction>;
  parking?: ParkingStatus;
  // Backend sürecinin kimliği — değişirse backend resetlenmiş demektir.
  boot_id?: string;
  // Sadece WebSocket'in bağlantı anındaki ilk mesajında: son 24 saatte canlı
  // yayında gösterilmiş anomali alarmları (bağlantı kopukken kaçırılanlar için).
  recent_anomaly_alerts?: Alert[];
};

export type Floor = { code: string; name: string; level_order: number };

export type ZoneInfo = { code: string; name: string; floor_id: number; zone_type: string; capacity: number | null };

export type PredictionHorizon = {
  horizon_minutes: number;
  predicted_count: number;
  predicted_occupancy_pct: number;
  level: OccupancyLevel;
  risk: "low" | "medium" | "high" | "critical";
  explanation: string;
  recommendations: string[];
};

export type ZonePrediction = {
  zone_code: string;
  zone_name: string;
  generated_at: string;
  current_count: number;
  current_occupancy_pct: number;
  predictions: PredictionHorizon[];
};

export type ParkingStatus = {
  lots: ZoneOccupancy[];
  recommended: { code: string; name: string; occupancy_pct: number } | null;
  warning: string | null;
};

export type HorizonMetric = { mae: number; mape?: number; sample_count?: number; train_rows?: number; test_rows?: number };

export type LiveHorizonMetric = {
  mae: number | null;
  pct_mae: number | null;
  accuracy_pct: number | null;
  sample_count: number;
  // "sabit tahmin" (şimdiki değer aynen kalır) tabanının hatası ve modelin ona göre hata azaltması
  baseline_pct_mae?: number | null;
  skill_pct?: number | null;
  // sadece AVM açıkken (gece hariç) hata
  open_pct_mae?: number | null;
  // tahmin edilen doluluk SEVİYESİ gerçekleşenle aynı mı (yüzde)
  level_accuracy_pct?: number | null;
  open_level_accuracy_pct?: number | null;
  baseline_level_accuracy_pct?: number | null;
};

export type ModelMetrics = {
  training: Record<string, HorizonMetric>;
  live: { window_hours: number; horizons: Record<string, LiveHorizonMetric> };
};

export type UnifiedAccuracy = {
  short_term: {
    live: Record<string, LiveHorizonMetric>;
    accuracy_pct: number | null;
    skill_pct?: number | null;
    pct_mae?: number | null;
    open_pct_mae?: number | null;
    level_accuracy_pct?: number | null;
    open_level_accuracy_pct?: number | null;
    baseline_level_accuracy_pct?: number | null;
  };
  anomaly: {
    live: {
      accuracy_pct: number | null;
      precision_pct: number | null;
      recall_pct: number | null;
      f1_pct: number | null;
      known_anomalies: number;
      true_positives: number;
      false_negatives: number;
      true_negatives: number;
      false_positives: number;
      total_week_anomalies: number;
    };
    accuracy_pct: number | null;
  };
  trend: {
    live: { accuracy_pct: number | null; pct_mae: number | null; sample_count: number };
    accuracy_pct: number | null;
  };
};

export type StoreResult = {
  store_id: number;
  name: string;
  category: string;
  zone_code: string;
  zone_name: string;
  floor_name: string;
  occupancy_pct: number | null;
  level: OccupancyLevel | null;
};

export type ReportsSummary = {
  busiest_days: { day: string; avg_occupancy_pct: number }[];
  busiest_hours: { hour: number; avg_occupancy_pct: number }[];
  busiest_zones: { zone_code: string; zone_name: string; avg_occupancy_pct: number }[];
  quietest_days: { day: string; avg_occupancy_pct: number }[];
  quietest_hours: { hour: number; avg_occupancy_pct: number }[];
  quietest_zones: { zone_code: string; zone_name: string; avg_occupancy_pct: number }[];
  week_over_week: { this_week_avg_pct: number; last_week_avg_pct: number; change_pct: number } | null;
  window_days: number | null;
};

type Compare<T> = { this: T; last: T | null; change_pct: number | null };
export type AlertCounts = { critical: number; warning: number; increase: number | null; decrease: number | null };
export type ComparisonRow = {
  this_pct: number | null;
  last_pct: number | null;
  change_pts: number | null;
  peak_pct: number | null;
};
export type WeeklyReport =
  | { available: false }
  | {
      available: true;
      has_last_week: boolean;
      this_week: { start: string; end: string };
      last_week: { start: string; end: string };
      kpis: {
        visitors: Compare<number>;
        avg_occupancy_pct: Compare<number | null>;
        peak: { timestamp: string; pct: number } | null;
      };
      alerts: { this: AlertCounts; last: AlertCounts | null };
      daily: {
        label: string;
        date: string;
        this_pct: number | null;
        last_pct: number | null;
        this_visitors: number;
        last_visitors: number | null;
      }[];
      heatmap: { dow: number; hour: number; pct: number }[];
      zones: (ComparisonRow & { zone_id: number; code: string; name: string; floor_name: string; level_order: number })[];
      floors: (ComparisonRow & { level_order: number; floor_name: string })[];
    };

export type DashboardCompare =
  | { available: false }
  | {
      available: true;
      now: string;
      day_start: string;
      inside: { now: number | null; hour_ago: number | null };
      occupancy_pct: { now: number | null };
      curve: { today: { t: string; pct: number; count: number }[]; forecast: { t: string; pct: number; count: number }[] };
    };

export type AnomalyEvent = {
  timestamp: string;
  zone_code: string;
  zone_name: string;
  occupancy_pct: number;
  model_verdict: "anomaly" | "normal";
  actual_label: "injected_anomaly" | "normal";
  outcome: "true_positive" | "false_positive" | "false_negative";
  score: number;
  // TFT'nin o an için beklediği doluluk (medyan) ve %98'lik bant (q01–q99)
  // (eski/yeniden başlatılmamış bir backend bunları göndermeyebilir)
  expected_pct?: number;
  band_low_pct?: number;
  band_high_pct?: number;
};

export type AnomalySummary = {
  accuracy_pct: number | null;
  precision_pct: number | null;
  recall_pct: number | null;
  f1_pct: number | null;
  known_anomalies: number;
  total_week_anomalies: number;
  total_week_normal: number;
  true_positives: number;
  false_negatives: number;
  true_negatives: number;
  false_positives: number;
};

export type AnomalyEventsResponse = {
  summary: AnomalySummary;
  events: AnomalyEvent[];
};

export type FloorTimeline = {
  floor_code: string;
  floor_name: string;
  level_order: number;
  day_start: string;
  now: string;
  actual: { t: string; pct: number }[];
  forecast: { t: string; pct: number }[];
};

export type TrendForecast = {
  zone_code: string;
  zone_name: string;
  forecast: {
    timestamp: string;
    predicted_occupancy_pct: number;
    predicted_count: number;
    actual_occupancy_pct: number | null;
    actual_count: number | null;
  }[];
};

export type TrendForecastAllZone = {
  code: string;
  name: string;
  floor_code: string;
  floor_name: string;
  floor_level_order: number;
  capacity: number | null;
  points: { target_timestamp: string; predicted_occupancy_pct: number; level: OccupancyLevel }[];
};

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API ${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Faz 8.46: `boot_id` her backend başlangıcında (her reset'te) değişen bir
  // kimlik — `notifications-context.tsx` bunu kullanarak backend resetlendiğinde
  // zil listesini/rozeti otomatik temizliyor. `mallBase()`'e bağlı DEĞİL (AVM'ye
  // özgü bir uç nokta değil).
  health: () => apiGet<{ status: string; boot_id: string }>("/health"),
  malls: () => apiGet<MallInfo[]>("/malls"),
  dashboardSummary: () => apiGet<DashboardSummary>(`${mallBase()}/dashboard/summary`),
  occupancy: () => apiGet<ZoneOccupancy[]>(`${mallBase()}/occupancy`),
  floors: () => apiGet<Floor[]>(`${mallBase()}/floors`),
  zones: () => apiGet<ZoneInfo[]>(`${mallBase()}/zones`),
  predict: (zoneCode: string) => apiGet<ZonePrediction>(`${mallBase()}/predict/${zoneCode}`),
  modelMetrics: () => apiGet<ModelMetrics>(`${mallBase()}/model/metrics`),
  alerts: () => apiGet<Alert[]>(`${mallBase()}/alerts`),
  parking: () => apiGet<ParkingStatus>(`${mallBase()}/parking`),
  reports: () => apiGet<ReportsSummary>(`${mallBase()}/reports/summary`),
  weeklyReport: () => apiGet<WeeklyReport>(`${mallBase()}/reports/weekly`),
  dashboardCompare: () => apiGet<DashboardCompare>(`${mallBase()}/dashboard/compare`),
  storeSearch: (q: string) => apiGet<StoreResult[]>(`${mallBase()}/stores/search?q=${encodeURIComponent(q)}`),
  storeCategories: () => apiGet<string[]>(`${mallBase()}/stores/categories`),
  trendForecast: (zoneCode: string) => apiGet<TrendForecast>(`${mallBase()}/trend/forecast?zone=${zoneCode}`),
  trendForecastAll: () => apiGet<TrendForecastAllZone[]>(`${mallBase()}/trend/forecast/all`),
  modelsAccuracy: () => apiGet<UnifiedAccuracy>(`${mallBase()}/models/accuracy`),
  anomalyEvents: () => apiGet<AnomalyEventsResponse>(`${mallBase()}/anomalies/events`),
  alertHistory: () => apiGet<Alert[]>(`${mallBase()}/alerts/history`),
  floorTimeline: () => apiGet<FloorTimeline[]>(`${mallBase()}/floors/timeline`),
};
