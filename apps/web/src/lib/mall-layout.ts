/**
 * AVM kat planları — Canlı Harita'daki 2D kat planı (`FloorPlan2D`) ile
 * 3D Görünüm (`MallBuilding3D`) AYNI tanımdan çizilir, böylece ikisi her
 * zaman aynı binayı gösterir.
 *
 * Plan koordinatları (metreye benzer birim): x → doğu, z → güney. Gerçek
 * AVM'lerin tipik düzeni: ortada doğu-batı yönünde bir galeri koridoru,
 * koridorun iki yanında vitrinli mağaza birimleri, koridorun ortasında
 * katları birbirine bağlayan bir atriyum (üst katlarda boşluk + korkuluk,
 * içinde yürüyen merdivenler). Giriş güney cephede.
 *
 * İzlenen bölgeler (zone) buradaki birimlere kodlarıyla eşlenir. Plan
 * tanımı olmayan bir AVM/kat için (ya da yeni bir bölge eklenirse) otomatik
 * yerleşim kullanılır — kat planı hiç kırılmaz, sadece daha basit görünür.
 */

import type { ZoneOccupancy } from "./api";

export type Rect = { x: number; z: number; w: number; d: number };

export type UnitStyle =
  | "store"
  | "food_court"
  | "cinema"
  | "kids"
  | "entertainment"
  | "entrance"
  | "kiosk"
  | "escalator"
  | "parking"
  | "service"
  | "vacant";

export type PlacedUnit = Rect & {
  style: UnitStyle;
  /** İzlenen bölge — `null` ise izlenmeyen (sensörsüz) bir mağaza birimi. */
  zone: ZoneOccupancy | null;
};

export type FloorPlan = {
  levelOrder: number;
  name: string;
  width: number;
  depth: number;
  isParking: boolean;
  /** Galeri koridoru (otoparkta araç şeridi). */
  corridor: Rect | null;
  /** Atriyum — zemin katta açık avlu, üst katlarda kat boşluğu (korkuluklu). */
  atrium: Rect | null;
  /** Dış cephedeki giriş kapısı (güney cephe). */
  entrance: Rect | null;
  /** Otopark rampası. */
  ramp: Rect | null;
  units: PlacedUnit[];
};

type ZoneSpec = Rect & { style?: UnitStyle };
type FloorSpec = {
  corridor: Rect | null;
  atrium?: Rect | null;
  entrance?: Rect | null;
  ramp?: Rect | null;
  zones: Record<string, ZoneSpec>;
  vacant?: Rect[];
};
type MallSpec = { width: number; depth: number; floors: Record<number, FloorSpec> };

const STYLE_BY_ZONE_TYPE: Record<string, UnitStyle> = {
  retail: "store",
  food_court: "food_court",
  cinema: "cinema",
  kids_area: "kids",
  entertainment: "entertainment",
  entrance: "entrance",
  info_desk: "kiosk",
  walkway: "escalator",
  parking: "parking",
  service: "service",
};

// --- Mall A (MallFlow AVM): 24 × 14, bodrum otopark + 3 mağaza katı ---------
const A_CORRIDOR: Rect = { x: 0, z: 5, w: 24, d: 4 };
const A_ATRIUM: Rect = { x: 9, z: 5.5, w: 6, d: 3 };

const MALL_A: MallSpec = {
  width: 24,
  depth: 14,
  floors: {
    [-1]: {
      corridor: { x: 0, z: 6, w: 24, d: 2.5 },
      ramp: { x: 17, z: 8.5, w: 7, d: 5.5 },
      zones: {
        ZONE_012: { x: 0, z: 0, w: 11, d: 6 },
        ZONE_013: { x: 13, z: 0, w: 11, d: 6 },
        ZONE_014: { x: 0, z: 8.5, w: 11, d: 5.5 },
      },
      vacant: [
        { x: 11, z: 0, w: 2, d: 6 },
        { x: 11, z: 8.5, w: 6, d: 5.5 },
      ],
    },
    0: {
      corridor: A_CORRIDOR,
      atrium: A_ATRIUM,
      entrance: { x: 10.5, z: 14, w: 3, d: 0 },
      zones: {
        ZONE_004: { x: 0, z: 0, w: 8, d: 5 },
        ZONE_005: { x: 16, z: 0, w: 8, d: 5 },
        ZONE_001: { x: 9, z: 9, w: 6, d: 5 },
        ZONE_006: { x: 3.5, z: 6, w: 2.6, d: 2 },
        ZONE_007: { x: 10, z: 5.8, w: 4, d: 2.4 },
      },
      vacant: [
        { x: 8, z: 0, w: 4, d: 5 },
        { x: 12, z: 0, w: 4, d: 5 },
        { x: 0, z: 9, w: 4.5, d: 5 },
        { x: 4.5, z: 9, w: 4.5, d: 5 },
        { x: 15, z: 9, w: 4.5, d: 5 },
        { x: 19.5, z: 9, w: 4.5, d: 5 },
      ],
    },
    1: {
      corridor: A_CORRIDOR,
      atrium: A_ATRIUM,
      zones: {
        ZONE_008: { x: 0, z: 0, w: 10, d: 5 },
        ZONE_009: { x: 16, z: 0, w: 8, d: 5 },
        ZONE_010: { x: 15, z: 9, w: 9, d: 5 },
      },
      vacant: [
        { x: 10, z: 0, w: 6, d: 5 },
        { x: 0, z: 9, w: 5, d: 5 },
        { x: 5, z: 9, w: 4.5, d: 5 },
        { x: 9.5, z: 9, w: 5.5, d: 5 },
      ],
    },
    2: {
      corridor: A_CORRIDOR,
      atrium: A_ATRIUM,
      zones: {
        ZONE_003: { x: 0, z: 0, w: 10, d: 5 },
        ZONE_011: { x: 14, z: 0, w: 10, d: 5 },
        ZONE_002: { x: 5, z: 9, w: 14, d: 5 },
      },
      vacant: [
        { x: 10, z: 0, w: 4, d: 5 },
        { x: 0, z: 9, w: 5, d: 5 },
        { x: 19, z: 9, w: 5, d: 5 },
      ],
    },
  },
};

// --- Mall B (Şehir Plaza): 18 × 12, 2 kat ------------------------------------
const B_CORRIDOR: Rect = { x: 0, z: 4.5, w: 18, d: 3 };
const B_ATRIUM: Rect = { x: 7, z: 4.75, w: 4, d: 2.5 };

const MALL_B: MallSpec = {
  width: 18,
  depth: 12,
  floors: {
    0: {
      corridor: B_CORRIDOR,
      atrium: B_ATRIUM,
      entrance: { x: 7.5, z: 12, w: 3, d: 0 },
      zones: {
        B_RETAIL_1: { x: 0, z: 0, w: 9, d: 4.5 },
        B_ENTRANCE: { x: 6, z: 7.5, w: 6, d: 4.5 },
        B_INFO: { x: 2.5, z: 5, w: 2.4, d: 2 },
        B_WALKWAY: { x: 7.5, z: 5, w: 3, d: 2 },
      },
      vacant: [
        { x: 9, z: 0, w: 4.5, d: 4.5 },
        { x: 13.5, z: 0, w: 4.5, d: 4.5 },
        { x: 0, z: 7.5, w: 6, d: 4.5 },
        { x: 12, z: 7.5, w: 6, d: 4.5 },
      ],
    },
    1: {
      corridor: B_CORRIDOR,
      atrium: B_ATRIUM,
      zones: {
        B_KIDS: { x: 0, z: 0, w: 9, d: 4.5 },
        B_FOODCOURT: { x: 9, z: 0, w: 9, d: 4.5 },
        B_SERVICE: { x: 0, z: 7.5, w: 4, d: 4.5 },
      },
      vacant: [
        { x: 4, z: 7.5, w: 5, d: 4.5 },
        { x: 9, z: 7.5, w: 9, d: 4.5 },
      ],
    },
  },
};

const MALL_SPECS: Record<string, MallSpec> = { "mall-a": MALL_A, "mall-b": MALL_B };

/** Plan tanımı yoksa: bölgeler koridorun kuzeyine ve güneyine eşit
 * genişlikte birimler olarak dizilir. */
function autoFloor(width: number, depth: number, zones: ZoneOccupancy[], isParking: boolean): FloorSpec {
  const corridorD = depth * 0.28;
  const rowD = (depth - corridorD) / 2;
  const north = zones.slice(0, Math.ceil(zones.length / 2));
  const south = zones.slice(north.length);
  const specs: Record<string, ZoneSpec> = {};
  [north, south].forEach((row, r) => {
    const cellW = width / Math.max(1, row.length);
    row.forEach((zone, i) => {
      specs[zone.code] = { x: i * cellW, z: r === 0 ? 0 : rowD + corridorD, w: cellW, d: rowD };
    });
  });
  return { corridor: { x: 0, z: rowD, w: width, d: corridorD }, atrium: isParking ? null : undefined, zones: specs };
}

export function buildFloorPlans(mallSlug: string, zones: ZoneOccupancy[]): FloorPlan[] {
  const spec = MALL_SPECS[mallSlug];
  const width = spec?.width ?? 24;
  const depth = spec?.depth ?? 14;

  const byFloor = new Map<number, { name: string; zones: ZoneOccupancy[] }>();
  for (const zone of zones) {
    const floor = byFloor.get(zone.floor_level_order) ?? { name: zone.floor_name, zones: [] };
    floor.zones.push(zone);
    byFloor.set(zone.floor_level_order, floor);
  }

  return [...byFloor.entries()]
    .sort(([a], [b]) => a - b)
    .map(([levelOrder, floor]) => {
      const isParking = floor.zones.every((z) => z.zone_type === "parking");
      const defined = spec?.floors[levelOrder];
      const complete = defined && floor.zones.every((z) => defined.zones[z.code]);
      const floorSpec = complete ? defined : autoFloor(width, depth, floor.zones, isParking);

      const units: PlacedUnit[] = floor.zones.map((zone) => {
        const rect = floorSpec.zones[zone.code];
        return { ...rect, style: rect.style ?? STYLE_BY_ZONE_TYPE[zone.zone_type] ?? "store", zone };
      });
      for (const rect of floorSpec.vacant ?? []) {
        units.push({ ...rect, style: isParking ? "service" : "vacant", zone: null });
      }

      return {
        levelOrder,
        name: floor.name,
        width,
        depth,
        isParking,
        corridor: floorSpec.corridor,
        atrium: floorSpec.atrium ?? null,
        entrance: floorSpec.entrance ?? null,
        ramp: floorSpec.ramp ?? null,
        units,
      };
    });
}

/** 0..1 arası deterministik sözde-rastgele — aynı bölge her render'da aynı
 * yerlerde insan gösterir (titreme olmasın), 2D ve 3D aynı noktaları kullanır. */
function hash01(seed: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) {
    h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  }
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Birim alan başına en fazla gösterilen figür — gerçek kişi sayısı değil,
// YOĞUNLUĞUN görsel karşılığı (%100 doluluk = alan × bu sayı kadar nokta).
const PEOPLE_PER_AREA = 0.9;
const MAX_PEOPLE_PER_UNIT = 60;

/** Bir birim içinde doluluğa orantılı insan (otoparkta araç yerine kullanılmaz)
 * konumları, plan koordinatlarında. */
export function peopleInUnit(unit: PlacedUnit): { x: number; z: number }[] {
  const occ = unit.zone?.occupancy_pct;
  if (!unit.zone || occ == null || unit.style === "parking") return [];
  const area = unit.w * unit.d;
  const count = Math.min(MAX_PEOPLE_PER_UNIT, Math.round((Math.min(occ, 150) / 100) * area * PEOPLE_PER_AREA));
  const margin = 0.35;
  return Array.from({ length: count }, (_, i) => ({
    x: unit.x + margin + hash01(unit.zone!.code, 2 * i) * (unit.w - 2 * margin),
    z: unit.z + margin + hash01(unit.zone!.code, 2 * i + 1) * (unit.d - 2 * margin),
  }));
}

/** Otopark biriminde park yeri ızgarası ve doluluğa göre dolu olanlar. */
export function parkingBays(unit: PlacedUnit): { x: number; z: number; w: number; d: number; filled: boolean }[] {
  const bayW = 1.2;
  const bayD = 2.2;
  const cols = Math.max(1, Math.floor(unit.w / bayW));
  const rows = Math.max(1, Math.floor(unit.d / bayD));
  const total = cols * rows;
  const filledCount = Math.round(Math.min(1, (unit.zone?.occupancy_pct ?? 0) / 100) * total);
  const offX = (unit.w - cols * bayW) / 2;
  const offZ = (unit.d - rows * bayD) / 2;
  const order = Array.from({ length: total }, (_, i) => i).sort(
    (a, b) => hash01(unit.zone?.code ?? "p", a) - hash01(unit.zone?.code ?? "p", b),
  );
  const filled = new Set(order.slice(0, filledCount));
  return Array.from({ length: total }, (_, i) => ({
    x: unit.x + offX + (i % cols) * bayW,
    z: unit.z + offZ + Math.floor(i / cols) * bayD,
    w: bayW,
    d: bayD,
    filled: filled.has(i),
  }));
}

export const STYLE_LABEL: Record<UnitStyle, string> = {
  store: "Mağaza",
  food_court: "Yeme-içme",
  cinema: "Sinema",
  kids: "Çocuk alanı",
  entertainment: "Eğlence",
  entrance: "Giriş",
  kiosk: "Danışma",
  escalator: "Yürüyen merdiven",
  parking: "Otopark",
  service: "Servis",
  vacant: "İzlenmeyen mağaza",
};
