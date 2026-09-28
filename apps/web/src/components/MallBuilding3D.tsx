"use client";

import { Environment, Html, Lightformer, OrbitControls, RoundedBox, Text } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ZoneOccupancy, ZonePrediction } from "@/lib/api";
import { ANOMALY_HEX, LEVEL_HEX } from "@/lib/level";
import { type FloorPlan, type PlacedUnit, type Rect, buildFloorPlans, parkingBays, peopleInUnit } from "@/lib/mall-layout";
import { ZoneDetailCard } from "./ZoneDetailCard";

/*
 * 3D Görünüm — Canlı Harita'daki 2D kat planıyla AYNI tanımdan (`lib/mall-layout.ts`)
 * kurulur. Plan koordinatları (x doğu, z güney) `S` ile ölçeklenip binanın
 * ortası orijine gelecek şekilde kaydırılır; kat yüksekliği `LEVEL_H`.
 *
 * Gerçek AVM düzeni: galeri koridoru, iki yanında vitrinli mağaza birimleri
 * (arka/yan bölme duvarları alçak tutuldu — içerisi yukarıdan görünsün),
 * üst katlarda korkuluklu atriyum boşluğu ve içinde yürüyen merdivenler,
 * en üstte atriyumun üzerinde cam tavan, bodrumda otopark.
 */

const S = 0.35;
const LEVEL_H = 1.25;
const SLAB_T = 0.12;
const PARTITION_H = 0.5;
const CINEMA_WALL_H = 0.85;
const SIGN_H = 0.14;
const RAIL_H = 0.22;

// Modern, açık tonlu mimari: beyaz paneller, açık taş döşeme, cilalı koridor,
// koyu cam tabelalar. Doluluk rengi zeminde yumuşak bir ton + kenarda LED şerit.
const PANEL_COLOR = "#f5f5f4";
const SLAB_COLOR = "#d6d3d1";
const PARKING_SLAB_COLOR = "#78716c";
const CORRIDOR_COLOR = "#fafaf9";
const PARTITION_COLOR = "#fafaf9";
const VACANT_COLOR = "#c7c2bd";
const GLASS_COLOR = "#bae6fd";
const MULLION_COLOR = "#27272a";
const SIGN_COLOR = "#0f172a";
const PEOPLE_COLOR = "#334155";
const CAR_COLORS = ["#e5e7eb", "#3b82f6", "#dc2626", "#18181b", "#facc15", "#6b7280"];

type Frame = { width: number; depth: number };

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.d && a.z + a.d > b.z;
}

/** Plan dikdörtgeninin merkezi, dünya koordinatlarında. */
function center(r: Rect, f: Frame): [number, number] {
  return [(r.x + r.w / 2 - f.width / 2) * S, (r.z + r.d / 2 - f.depth / 2) * S];
}

function floorY(levelOrder: number) {
  return levelOrder * LEVEL_H;
}

function Box({
  args,
  position,
  color,
  opacity = 1,
  emissive,
  emissiveIntensity = 0,
  metalness = 0.05,
  roughness = 0.85,
}: {
  args: [number, number, number];
  position: [number, number, number];
  color: string;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
}) {
  const transparent = opacity < 1;
  return (
    <mesh position={position} castShadow={!transparent} receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial
        color={color}
        emissive={emissive ?? color}
        emissiveIntensity={emissiveIntensity}
        metalness={metalness}
        roughness={roughness}
        transparent={transparent}
        opacity={opacity}
        depthWrite={!transparent}
      />
    </mesh>
  );
}

/** Kat döşemesi — üst katlarda atriyumun olduğu yer BOŞ (dört parça). */
function Slab({ plan, y, opening }: { plan: FloorPlan; y: number; opening?: Rect }) {
  const f: Frame = plan;
  const hole = opening ?? (plan.levelOrder > 0 ? plan.atrium : null);
  const pieces: Rect[] = hole
    ? [
        { x: 0, z: 0, w: plan.width, d: hole.z },
        { x: 0, z: hole.z + hole.d, w: plan.width, d: plan.depth - hole.z - hole.d },
        { x: 0, z: hole.z, w: hole.x, d: hole.d },
        { x: hole.x + hole.w, z: hole.z, w: plan.width - hole.x - hole.w, d: hole.d },
      ]
    : [{ x: 0, z: 0, w: plan.width, d: plan.depth }];
  return (
    <>
      {pieces.map((r, i) => {
        const [cx, cz] = center(r, f);
        return (
          <Box
            key={i}
            args={[r.w * S, SLAB_T, r.d * S]}
            position={[cx, y - SLAB_T / 2, cz]}
            color={plan.isParking ? PARKING_SLAB_COLOR : SLAB_COLOR}
            roughness={0.7}
          />
        );
      })}
      {plan.corridor && (
        // koridor zemini (parlak, cilalı taş hissi) — atriyum boşluğunu örtmesin diye aynı parçalama
        <CorridorFloor plan={plan} y={y} opening={opening} />
      )}
    </>
  );
}

function CorridorFloor({ plan, y, opening }: { plan: FloorPlan; y: number; opening?: Rect }) {
  const c = plan.corridor!;
  const candidate = opening ?? (plan.levelOrder > 0 ? plan.atrium : null);
  const hole = candidate && overlaps(c, candidate) ? {
    x: Math.max(c.x, candidate.x), z: Math.max(c.z, candidate.z),
    w: Math.min(c.x + c.w, candidate.x + candidate.w) - Math.max(c.x, candidate.x),
    d: Math.min(c.z + c.d, candidate.z + candidate.d) - Math.max(c.z, candidate.z),
  } : null;
  const pieces: Rect[] = hole
    ? [
        { x: c.x, z: c.z, w: hole.x - c.x, d: c.d },
        { x: hole.x + hole.w, z: c.z, w: c.x + c.w - hole.x - hole.w, d: c.d },
        { x: hole.x, z: c.z, w: hole.w, d: hole.z - c.z },
        { x: hole.x, z: hole.z + hole.d, w: hole.w, d: c.z + c.d - hole.z - hole.d },
      ].filter((r) => r.w > 0.01 && r.d > 0.01)
    : [c];
  return (
    <>
      {pieces.map((r, i) => {
        const [cx, cz] = center(r, plan);
        return (
          <mesh key={i} position={[cx, y + 0.002, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[r.w * S, r.d * S]} />
            <meshStandardMaterial
              color={plan.isParking ? "#44403c" : CORRIDOR_COLOR}
              metalness={plan.isParking ? 0.05 : 0.35}
              roughness={plan.isParking ? 0.9 : 0.18}
            />
          </mesh>
        );
      })}
    </>
  );
}

/** Birimin koridora bakan kenarı (vitrin tarafı). */
function frontSide(unit: PlacedUnit, plan: FloorPlan): "north" | "south" | null {
  const c = plan.corridor;
  if (!c) return null;
  if (unit.z + unit.d <= c.z + 0.01) return "south";
  if (unit.z >= c.z + c.d - 0.01) return "north";
  return null;
}

/** Anomali varsa zemin rengini yanıp söndüren malzeme. */
function PulsingMaterial({ color, anomaly, active }: { color: string; anomaly: boolean; active: boolean }) {
  const ref = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    if (anomaly) {
      const t = (Math.sin(clock.elapsedTime * 4) + 1) / 2;
      ref.current.emissive.set(ANOMALY_HEX);
      ref.current.emissiveIntensity = 0.3 + 0.9 * t;
    } else {
      ref.current.emissive.set(color);
      ref.current.emissiveIntensity = active ? 0.45 : 0.12;
    }
  });
  return <meshStandardMaterial ref={ref} color={color} roughness={0.5} transparent opacity={0.45} depthWrite={false} />;
}

/** Birimin zemin kenarında doluluk renginde parlayan LED şerit (anomalide mavi yanıp söner). */
function EdgeGlow({ w, d, color, anomaly, strong }: { w: number; d: number; color: string; anomaly: boolean; strong: boolean }) {
  // dört kenar her karede birlikte güncellenir — anomalide hepsi aynı anda yanıp söner
  const materials = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  useFrame(({ clock }) => {
    const opacity = anomaly ? 0.35 + 0.65 * ((Math.sin(clock.elapsedTime * 4) + 1) / 2) : 1;
    for (const m of materials.current) {
      if (!m) continue;
      m.color.set(anomaly ? ANOMALY_HEX : strong ? "#ffffff" : color);
      m.opacity = opacity;
    }
  });
  const t = strong ? 0.035 : 0.022;
  const edges: [number, number, number, number][] = [
    [w, t, 0, -d / 2 + t / 2],
    [w, t, 0, d / 2 - t / 2],
    [t, d, -w / 2 + t / 2, 0],
    [t, d, w / 2 - t / 2, 0],
  ];
  return (
    <>
      {edges.map(([bw, bd, bx, bz], i) => (
        <mesh key={i} position={[bx, 0.012, bz]}>
          <boxGeometry args={[bw, 0.012, bd]} />
          <meshBasicMaterial
            ref={(m) => {
              materials.current[i] = m;
            }}
            color={color}
            transparent
            toneMapped={false}
          />
        </mesh>
      ))}
    </>
  );
}

function StoreUnit({
  unit,
  plan,
  y,
  selected,
  anomaly,
  onSelect,
  onFloorClick,
}: {
  unit: PlacedUnit;
  plan: FloorPlan;
  y: number;
  selected: boolean;
  anomaly: boolean;
  onSelect: (code: string | null) => void;
  /** İzlenmeyen bir birime tıklanınca katı açar. */
  onFloorClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const zone = unit.zone;
  const [cx, cz] = center(unit, plan);
  const w = unit.w * S;
  const d = unit.d * S;
  const color = zone?.level ? LEVEL_HEX[zone.level] : zone ? "#71717a" : VACANT_COLOR;
  const front = frontSide(unit, plan);
  const openFront = unit.style === "food_court" || unit.style === "entrance" || unit.style === "escalator";
  const freestanding = unit.style === "kiosk" || unit.style === "escalator";
  const wallH = unit.style === "cinema" ? CINEMA_WALL_H : PARTITION_H;
  const wallT = 0.03;
  const frontZ = front === "south" ? d / 2 : front === "north" ? -d / 2 : null;
  const backZ = frontZ === null ? null : -frontZ;

  // Bölgenin TAMAMI (zemin, duvarlar, vitrin, tabela) tıklanabilir — olaylar
  // grup üzerinde yakalanıyor; sadece ince zemine tıklamak yandan bakınca zordu.
  const interactive = !!zone || !!onFloorClick;
  const handlers = interactive
    ? {
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          // Bölgeye tıklanınca (hangi katta olursa olsun) üst bileşen o katı açar
          // ve bölgeye zoom yapar; izlenmeyen birime tıklanınca sadece kat açılır.
          if (zone) onSelect(zone.code);
          else onFloorClick?.();
        },
        onPointerOver: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        },
        onPointerOut: () => {
          setHovered(false);
          document.body.style.cursor = "";
        },
      }
    : {};

  return (
    <group position={[cx, y, cz]} {...handlers}>
      {zone && hovered && (
        <Html position={[0, (unit.style === "cinema" ? CINEMA_WALL_H : PARTITION_H) + 0.32, 0]} center style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap rounded-full border border-white/15 bg-neutral-950/90 px-2.5 py-1 text-[11px] text-white shadow-lg">
            {zone.name} · <span style={{ color }}>%{zone.occupancy_pct != null ? zone.occupancy_pct.toFixed(0) : "-"}</span>
          </div>
        </Html>
      )}
      {/* doluluk rengindeki zemin */}
      {unit.style !== "escalator" && <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w * 0.98, d * 0.98]} />
        {zone ? (
          <PulsingMaterial color={color} anomaly={anomaly} active={hovered || selected} />
        ) : (
          <meshStandardMaterial color={VACANT_COLOR} roughness={0.8} />
        )}
      </mesh>}

      {zone && <EdgeGlow w={w * 0.98} d={d * 0.98} color={color} anomaly={anomaly} strong={selected || hovered} />}

      {!freestanding && frontZ !== null && backZ !== null && (
        <>
          {/* arka ve yan bölme duvarları */}
          <Box args={[w, wallH, wallT]} position={[0, wallH / 2, backZ]} color={unit.style === "cinema" ? "#27272a" : PARTITION_COLOR} opacity={0.92} />
          {[-1, 1].map((side) => (
            <Box
              key={side}
              args={[wallT, wallH, d]}
              position={[(side * w) / 2, wallH / 2, 0]}
              color={unit.style === "cinema" ? "#27272a" : PARTITION_COLOR}
              opacity={0.92}
            />
          ))}
          {/* vitrin: cam cephe (açık cepheli birimlerde yok) + tabela bandı */}
          {!openFront && (
            <Box args={[w * 0.96, wallH * 0.82, 0.015]} position={[0, (wallH * 0.82) / 2, frontZ]} color={GLASS_COLOR} opacity={0.22} emissiveIntensity={0.1} metalness={0.3} roughness={0.05} />
          )}
          <Box args={[w, SIGN_H, 0.05]} position={[0, wallH + SIGN_H / 2 - 0.02, frontZ]} color={SIGN_COLOR} metalness={0.5} roughness={0.2} />
          {zone && (
            <>
              <Box args={[w, 0.025, 0.055]} position={[0, wallH - 0.02, frontZ]} color={color} emissiveIntensity={0.8} />
              <Text
                position={[0, wallH + SIGN_H / 2 - 0.02, frontZ + (front === "south" ? 0.03 : -0.03)]}
                rotation={[0, front === "south" ? 0 : Math.PI, 0]}
                fontSize={Math.min(0.1, (w / Math.max(6, zone.name.length)) * 1.5)}
                color="white"
                anchorX="center"
                anchorY="middle"
              >
                {`${zone.name}  %${zone.occupancy_pct != null ? zone.occupancy_pct.toFixed(0) : "-"}`}
              </Text>
            </>
          )}
        </>
      )}

      {unit.style === "cinema" && backZ !== null && (
        // perde
        <Box args={[w * 0.75, wallH * 0.55, 0.02]} position={[0, wallH * 0.55, backZ + (backZ > 0 ? -0.03 : 0.03)]} color="#e0f2fe" emissiveIntensity={0.9} />
      )}

      {unit.style === "food_court" && <FoodCourtTables w={w} d={d} />}

      {unit.style === "kiosk" && (
        <>
          <RoundedBox args={[w * 0.7, 0.28, d * 0.45]} radius={0.04} position={[0, 0.14, 0]}>
            <meshStandardMaterial color="#e4e4e7" roughness={0.4} />
          </RoundedBox>
          {zone && (
            <Text position={[0, 0.42, 0]} fontSize={0.08} color="white" anchorX="center" anchorY="middle">
              {`${zone.name} %${zone.occupancy_pct != null ? zone.occupancy_pct.toFixed(0) : "-"}`}
            </Text>
          )}
        </>
      )}

      {unit.style === "parking" && <ParkedCars unit={unit} plan={plan} />}
    </group>
  );
}

function FoodCourtTables({ w, d }: { w: number; d: number }) {
  const cols = Math.max(2, Math.floor(w / 0.7));
  const rows = Math.max(2, Math.floor(d / 0.7));
  return (
    <>
      {Array.from({ length: cols * rows }, (_, i) => (
        <mesh key={i} position={[-w / 2 + ((i % cols) + 0.5) * (w / cols), 0.09, -d / 2 + (Math.floor(i / cols) + 0.5) * (d / rows)]}>
          <cylinderGeometry args={[0.09, 0.09, 0.02, 12]} />
          <meshStandardMaterial color="#f5f5f4" roughness={0.5} />
        </mesh>
      ))}
    </>
  );
}

function ParkedCars({ unit, plan }: { unit: PlacedUnit; plan: FloorPlan }) {
  const [ux, uz] = center(unit, plan);
  return (
    <>
      {parkingBays(unit).map((bay, i) => {
        const [bx, bz] = center(bay, plan);
        const x = bx - ux;
        const z = bz - uz;
        return (
          <group key={i} position={[x, 0, z]}>
            <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[bay.w * S * 0.96, bay.d * S * 0.96]} />
              <meshBasicMaterial color="#e5e7eb" transparent opacity={0.08} />
            </mesh>
            {bay.filled && (
              <>
                <RoundedBox args={[bay.w * S * 0.62, 0.07, bay.d * S * 0.72]} radius={0.025} position={[0, 0.06, 0]}>
                  <meshStandardMaterial color={CAR_COLORS[i % CAR_COLORS.length]} metalness={0.6} roughness={0.25} />
                </RoundedBox>
                <RoundedBox args={[bay.w * S * 0.5, 0.05, bay.d * S * 0.36]} radius={0.02} position={[0, 0.115, -0.01]}>
                  <meshStandardMaterial color="#0d1420" metalness={0.3} roughness={0.15} />
                </RoundedBox>
              </>
            )}
          </group>
        );
      })}
    </>
  );
}

/** Bir kattaki tüm insan figürleri — tek bir InstancedMesh (performans). */
function People({ plan, y }: { plan: FloorPlan; y: number }) {
  const points = useMemo(() => plan.units.flatMap((u) => peopleInUnit(u)), [plan]);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const m = new THREE.Matrix4();
    points.forEach((p, i) => {
      m.makeTranslation((p.x - plan.width / 2) * S, y + 0.06, (p.z - plan.depth / 2) * S);
      ref.current!.setMatrixAt(i, m);
    });
    ref.current.count = points.length;
    ref.current.instanceMatrix.needsUpdate = true;
  }, [points, plan, y]);
  if (points.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, Math.max(points.length, 1)]} key={points.length}>
      <capsuleGeometry args={[0.022, 0.07, 3, 6]} />
      <meshStandardMaterial color={PEOPLE_COLOR} roughness={0.6} />
    </instancedMesh>
  );
}

/** Üst katlarda atriyum boşluğunun etrafındaki cam korkuluk. */
function AtriumRailing({ plan, y }: { plan: FloorPlan; y: number }) {
  const a = plan.atrium!;
  const [cx, cz] = center(a, plan);
  const w = a.w * S;
  const d = a.d * S;
  const sides: { args: [number, number, number]; pos: [number, number] }[] = [
    { args: [w, RAIL_H, 0.015], pos: [0, -d / 2] },
    { args: [w, RAIL_H, 0.015], pos: [0, d / 2] },
    // Merdiven şeritlerinin önünde geçiş açıklıkları bırakılır.
    ...[-1, 1].flatMap((edge) => {
      const gapHalf = 0.13;
      const lanes = [-d * 0.18, d * 0.18];
      const spans = [[-d / 2, lanes[0] - gapHalf],
        [lanes[0] + gapHalf, lanes[1] - gapHalf], [lanes[1] + gapHalf, d / 2]];
      return spans.filter(([start, end]) => end - start > 0.01).map(([start, end]) => ({
        args: [0.015, RAIL_H, end - start] as [number, number, number],
        pos: [edge * w / 2, (start + end) / 2] as [number, number],
      }));
    }),
  ];
  return (
    <group position={[cx, y, cz]}>
      {sides.map((s, i) => (
        <group key={i}>
          <Box args={s.args} position={[s.pos[0], RAIL_H / 2, s.pos[1]]} color={GLASS_COLOR} opacity={0.3} metalness={0.3} roughness={0.05} />
          <Box
            args={[Math.max(s.args[0], 0.03), 0.02, Math.max(s.args[2], 0.03)]}
            position={[s.pos[0], RAIL_H, s.pos[1]]}
            color="#d4d4d8"
            metalness={0.8}
            roughness={0.2}
          />
        </group>
      ))}
    </group>
  );
}

/** İki kat arasında, atriyumun içinde yan yana iki yürüyen merdiven (çıkış/iniş). */
function Escalators({ plan, fromLevel, alongZ = false }: { plan: FloorPlan; fromLevel: number; alongZ?: boolean }) {
  const a = plan.atrium!;
  const [cx, cz] = center(a, plan);
  const openingLength = (alongZ ? a.d : a.w) * S;
  const run = openingLength * 0.78;
  // Sahanlık açıklığın kenarını aşarak kat döşemesine bağlanır.
  const landingLength = (openingLength - run) / 2 + 0.15;
  const rise = LEVEL_H;
  const len = Math.hypot(run, rise);
  const angle = Math.atan2(rise, run);
  const y0 = floorY(fromLevel);
  const stepCount = Math.max(16, Math.ceil(run / 0.075));
  const treadDepth = run / stepCount;
  const stepRise = rise / (stepCount - 1);
  return (
    <group position={[cx, y0 + rise / 2, cz]} rotation={[0, alongZ ? Math.PI / 2 : 0, 0]}>
      {[-1, 1].map((side) => (
        <group key={side} position={[0, 0, side * (alongZ ? a.w : a.d) * S * 0.18]}>
          <group rotation={[0, 0, side * angle]}>
            <Box args={[len, 0.05, 0.16]} position={[0, -stepRise - 0.03, 0]} color="#52525b" metalness={0.6} roughness={0.3} />
            {[-1, 1].map((edge) => (
              <Box key={edge} args={[len, 0.09, 0.012]} position={[0, 0.06, edge * 0.085]} color={GLASS_COLOR} opacity={0.35} />
            ))}
          </group>
          {/* Basamaklar eğimli gruptan bağımsızdır; ayak basılan yüzey yatay kalır. */}
          {Array.from({ length: stepCount }, (_, i) => {
            const x = -run / 2 + (i + 0.5) * treadDepth;
            const top = side * (-rise / 2 + i * stepRise);
            return (
              <group key={`step-${i}`} position={[x, top, 0]}>
                <Box args={[treadDepth, stepRise + 0.025, 0.16]}
                  position={[0, -(stepRise + 0.025) / 2, 0]} color="#666d73" metalness={0.55} roughness={0.48} />
                <Box args={[0.008, 0.004, 0.155]}
                  position={[-side * (treadDepth / 2 - 0.005), 0.002, 0]} color="#d7bb62" roughness={0.65} />
                {[-0.05, -0.025, 0, 0.025, 0.05].map((z) => (
                  <Box key={z} args={[Math.max(0.01, treadDepth - 0.018), 0.002, 0.002]}
                    position={[0, 0.001, z]} color="#969da1" metalness={0.6} />
                ))}
              </group>
            );
          })}
          {[-1, 1].map((end) => (
            <group key={end} position={[end * (run / 2 + landingLength / 2), end * side * rise / 2, 0]}>
              <Box args={[landingLength, 0.045, 0.25]} position={[0, -0.0225, 0]} color="#c2c5c3" metalness={0.35} roughness={0.6} />
              {/* Düz tarak plakası; platformun giriş/çıkış yüzü tamamen açıktır. */}
              <Box args={[0.035, 0.006, 0.18]} position={[-end * (landingLength / 2 - 0.025), 0.003, 0]} color="#d7bb62" />
              {[-1, 1].map((edge) => (
                <Box key={edge} args={[landingLength, 0.12, 0.012]} position={[0, 0.06, edge * 0.125]} color={GLASS_COLOR} opacity={0.35} />
              ))}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Araç yolundan ayrılmış sahanlık ve koridora uzanan işaretli yaya geçidi. */
function ParkingPedestrianBay({ plan, bay }: { plan: FloorPlan; bay: Rect }) {
  const [x, z] = center(bay, plan);
  const y = floorY(plan.levelOrder);
  const w = bay.w * S, d = bay.d * S;
  const corridor = plan.corridor!;
  return (
    <group>
      <Box args={[w, 0.035, d]} position={[x, y - 0.012, z]} color="#82938a" />
      {[-1, 1].map((side) => (
        <group key={side}>
          <Box args={[0.025, 0.025, d]} position={[x + side * (w / 2 - 0.03), y + 0.23, z]} color="#d4d4d8" metalness={0.7} />
          {[-0.4, 0, 0.4].map((t) => (
            <Box key={t} args={[0.025, 0.23, 0.025]} position={[x + side * (w / 2 - 0.03), y + 0.115, z + t * d]} color="#d4d4d8" />
          ))}
        </group>
      ))}
      {Array.from({ length: 7 }, (_, i) => (
        <Box key={i} args={[w * 0.8, 0.008, corridor.d * S / 14]}
          position={[x, y + 0.012, (corridor.z - plan.depth / 2) * S + (i + 0.5) * corridor.d * S / 7]} color="#ece9d9" />
      ))}
    </group>
  );
}

/** Giydirme cam cephe: cam + ince dikey çerçeveler (kayıtlar). */
function CurtainWall({
  length,
  height,
  position,
  axis,
}: {
  length: number;
  height: number;
  position: [number, number, number];
  axis: "x" | "z";
}) {
  const frameWidth = 0.012;
  const count = Math.max(1, Math.round(length / 0.7));
  const spacing = (length - frameWidth) / count;
  const glassHeight = Math.max(0.01, height - frameWidth * 2 - 0.004);
  const frameColor = "#9ba5ac";
  return (
    <group position={position}>
      {/* Cam çerçevelerin içinden geçmez; her açıklığa ayrı bir panel oturur. */}
      {Array.from({ length: count }, (_, i) => {
        const off = -length / 2 + frameWidth / 2 + (i + 0.5) * spacing;
        const paneWidth = Math.max(0.01, spacing - frameWidth - 0.004);
        return (
          <mesh key={`glass-${i}`} position={axis === "x" ? [off, 0, 0] : [0, 0, off]}
            rotation={[0, axis === "z" ? Math.PI / 2 : 0, 0]}>
            <planeGeometry args={[paneWidth, glassHeight]} />
            <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.12}
              metalness={0.25} roughness={0.15} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
      {Array.from({ length: count + 1 }, (_, i) => {
        const off = -length / 2 + frameWidth / 2 + i * spacing;
        return (
          <mesh key={`frame-${i}`} position={axis === "x" ? [off, 0, 0] : [0, 0, off]}>
            <boxGeometry args={axis === "x"
              ? [frameWidth, height - 2 * frameWidth, 0.018]
              : [0.018, height - 2 * frameWidth, frameWidth]} />
            <meshStandardMaterial color={frameColor} metalness={0.45} roughness={0.5} />
          </mesh>
        );
      })}
      {[-1, 1].map((edge) => (
        <mesh key={edge} position={[0, edge * (height - frameWidth) / 2, 0]}>
          <boxGeometry args={axis === "x" ? [length, frameWidth, 0.018] : [0.018, frameWidth, length]} />
          <meshStandardMaterial color={frameColor} metalness={0.45} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

/** Dış kabuk: kuzey ve batı cepheler beyaz kompozit panel (arka plan), kameraya
 * bakan güney (giriş) ve doğu cepheler giydirme cam — içerisi dışarıdan görünür.
 * Bodrum otoparkta güney/doğu açık, sadece arka duvarlar var. */
function Facade({ plan, y, height }: { plan: FloorPlan; y: number; height: number }) {
  const W = plan.width * S;
  const D = plan.depth * S;
  const t = 0.05;
  const panel = { color: plan.isParking ? PARKING_SLAB_COLOR : PANEL_COLOR, roughness: 0.55, metalness: 0.1 };
  const door = plan.entrance;
  const southSegments: [number, number][] = door
    ? [
        [0, door.x],
        [door.x + door.w, plan.width],
      ]
    : [[0, plan.width]];
  return (
    <group position={[0, y + height / 2, 0]}>
      <Box args={[W + t, height, t]} position={[0, 0, -D / 2]} {...panel} />
      <Box args={[t, height, D]} position={[-W / 2, 0, 0]} {...panel} />
      {!plan.isParking && (
        <>
          <CurtainWall length={D - 0.04} height={height} position={[W / 2, 0, 0]} axis="z" />
          {southSegments.map(([a, b], i) => (
            <CurtainWall
              key={i}
              length={(b - a) * S}
              height={height}
              position={[((a + b) / 2 - plan.width / 2) * S, 0, D / 2]}
              axis="x"
            />
          ))}
        </>
      )}
    </group>
  );
}

/** Çatıdaki AVM tabelası — çatıya ankrajlı çelik dikmeler, arkada yatay kuşaklar
 * ve çapraz payandalarla taşınır; tabelanın alt kenarı çatıdan yukarıda. */
function RoofSign({ mallName, roofY, z }: { mallName: string; roofY: number; z: number }) {
  const signW = Math.max(2.4, mallName.length * 0.17 + 0.6);
  const signH = 0.42;
  const clearance = 0.18; // çatı ile tabela alt kenarı arası
  const signY = roofY + clearance + signH / 2;
  const postH = clearance + signH;
  const postXs = signW > 3 ? [-signW / 2 + 0.3, 0, signW / 2 - 0.3] : [-signW / 2 + 0.3, signW / 2 - 0.3];
  const steel = { color: "#3f3f46", metalness: 0.7, roughness: 0.35 };
  const backZ = z - 0.08;
  const braceLen = Math.hypot(postH * 0.8, 0.35);
  const braceAngle = Math.atan2(0.35, postH * 0.8);
  return (
    <group>
      {postXs.map((x) => (
        <group key={x}>
          {/* dikme + taban plakası */}
          <Box args={[0.05, postH, 0.05]} position={[x, roofY + postH / 2, backZ]} {...steel} />
          <Box args={[0.14, 0.02, 0.14]} position={[x, roofY + 0.01, backZ]} {...steel} />
          {/* arkaya çapraz payanda (rüzgâr yüküne karşı) */}
          <mesh position={[x, roofY + (postH * 0.8) / 2, backZ - 0.175]} rotation={[braceAngle, 0, 0]}>
            <boxGeometry args={[0.03, braceLen, 0.03]} />
            <meshStandardMaterial {...steel} />
          </mesh>
          <Box args={[0.1, 0.02, 0.1]} position={[x, roofY + 0.01, backZ - 0.35]} {...steel} />
        </group>
      ))}
      {/* tabelanın arkasındaki yatay kuşaklar */}
      {[signY - signH * 0.3, signY + signH * 0.3].map((yy) => (
        <Box key={yy} args={[signW - 0.1, 0.035, 0.035]} position={[0, yy, backZ + 0.02]} {...steel} />
      ))}
      <group position={[0, signY, z]}>
        <Box args={[signW, signH, 0.08]} position={[0, 0, 0]} color="#1d4ed8" metalness={0.2} roughness={0.4} />
        <Text position={[0, 0, 0.05]} fontSize={0.24} color="white" anchorX="center" anchorY="middle" fontWeight="bold">
          {mallName}
        </Text>
      </group>
    </group>
  );
}

function Roof({ plan, y, mallName }: { plan: FloorPlan; y: number; mallName: string }) {
  const hole = plan.atrium;
  const f: Frame = plan;
  const pieces: Rect[] = hole
    ? [
        { x: 0, z: 0, w: plan.width, d: hole.z },
        { x: 0, z: hole.z + hole.d, w: plan.width, d: plan.depth - hole.z - hole.d },
        { x: 0, z: hole.z, w: hole.x, d: hole.d },
        { x: hole.x + hole.w, z: hole.z, w: plan.width - hole.x - hole.w, d: hole.d },
      ]
    : [{ x: 0, z: 0, w: plan.width, d: plan.depth }];
  return (
    <>
      {pieces.map((r, i) => {
        const [cx, cz] = center(r, f);
        return <Box key={i} args={[r.w * S, SLAB_T, r.d * S]} position={[cx, y + SLAB_T / 2, cz]} color={PANEL_COLOR} roughness={0.5} />;
      })}
      {hole && (
        // atriyumun üstünde piramit cam tavan (skylight)
        <mesh position={[center(hole, f)[0], y + SLAB_T + 0.2, center(hole, f)[1]]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[(Math.hypot(hole.w, hole.d) * S) / 2, 0.4, 4, 1, true]} />
          <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.3} metalness={0.3} roughness={0.05} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      <RoofSign mallName={mallName} roofY={y + SLAB_T} z={(-plan.depth / 2) * S + 0.25} />
    </>
  );
}

function FloorLevel({
  plan,
  selected,
  anomalyCodes,
  onSelect,
  onFloorClick,
  hasCeiling,
  opening,
  pedestrianBay,
}: {
  plan: FloorPlan;
  selected: string | null;
  anomalyCodes: Set<string>;
  onSelect: (code: string | null) => void;
  onFloorClick?: () => void;
  /** Üstünde görünür bir döşeme/çatı var mı — yoksa tavan aydınlatması havada kalırdı. */
  hasCeiling: boolean;
  opening?: Rect;
  pedestrianBay?: Rect;
}) {
  const y = floorY(plan.levelOrder);
  return (
    <group>
      <group
        onClick={
          onFloorClick
            ? (e) => {
                e.stopPropagation();
                onFloorClick();
              }
            : undefined
        }
      >
        <Slab plan={plan} y={y} opening={opening} />
      </group>
      {plan.levelOrder > 0 && plan.atrium && <AtriumRailing plan={plan} y={y} />}
      {plan.ramp && (
        <mesh position={[center(plan.ramp, plan)[0], y + 0.004, center(plan.ramp, plan)[1]]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[plan.ramp.w * S, plan.ramp.d * S]} />
          <meshStandardMaterial color="#f59e0b" transparent opacity={0.25} />
        </mesh>
      )}
      {plan.units.filter((unit) => !(pedestrianBay && !unit.zone && (unit.style === "vacant" || unit.style === "service") && overlaps(unit, pedestrianBay))).map((unit, i) => (
        <StoreUnit
          key={unit.zone?.code ?? `vacant-${i}`}
          unit={unit}
          plan={plan}
          y={y}
          selected={!!unit.zone && unit.zone.code === selected}
          anomaly={!!unit.zone && anomalyCodes.has(unit.zone.code)}
          onSelect={onSelect}
          onFloorClick={onFloorClick}
        />
      ))}
      <People plan={plan} y={y} />
      {/* tavan aydınlatması — sadece üstünde tavan varken (kat açıkken üst katlar gizli) */}
      {plan.corridor && hasCeiling && (
        <mesh position={[center(plan.corridor, plan)[0], y + LEVEL_H - SLAB_T - 0.01, center(plan.corridor, plan)[1]]}>
          <boxGeometry args={[plan.corridor.w * S * 0.85, 0.015, 0.04]} />
          <meshStandardMaterial color="#fef9c3" emissive="#fef9c3" emissiveIntensity={1.2} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function DoorLeaf({ width, height, handleSide }: { width: number; height: number; handleSide: 1 | -1 }) {
  return (
    <>
      <mesh>
        <boxGeometry args={[width - 0.01, height, 0.012]} />
        <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.28} metalness={0.9} roughness={0.05} depthWrite={false} />
      </mesh>
      <mesh position={[handleSide * (width / 2 - 0.02), 0, 0.008]}>
        <boxGeometry args={[0.012, height * 0.35, 0.012]} />
        <meshStandardMaterial color="#d4d4d8" metalness={0.9} roughness={0.2} />
      </mesh>
    </>
  );
}

/** Otomatik sürgülü cam kapı — kanatlar yavaşça açılıp kapanır (içeri giren ziyaretçi hissi). */
function SlidingDoors({ width, height }: { width: number; height: number }) {
  const left = useRef<THREE.Group>(null);
  const right = useRef<THREE.Group>(null);
  const leafW = width / 2;
  useFrame(({ clock }) => {
    const open = Math.max(0, Math.sin(clock.elapsedTime * 0.6)) * leafW * 0.85;
    if (left.current) left.current.position.x = -leafW / 2 - open;
    if (right.current) right.current.position.x = leafW / 2 + open;
  });
  return (
    <>
      <group ref={left} position={[-leafW / 2, height / 2, 0]}>
        <DoorLeaf width={leafW} height={height} handleSide={1} />
      </group>
      <group ref={right} position={[leafW / 2, height / 2, 0]}>
        <DoorLeaf width={leafW} height={height} handleSide={-1} />
      </group>
    </>
  );
}

/** Sabit varyasyon: canlı veriler güncellenirken peyzaj şekli değişmez. */
function rand(seed: number, i: number) {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Küçük yaprak topları yerine kesintisiz, hafif düzensiz bir taç yüzeyi. */
function NaturalCrown({ seed }: { seed: number }) {
  const geometry = useMemo(() => {
    const crown = new THREE.SphereGeometry(1, 32, 24);
    const positions = crown.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      // Koordinata bağlı deformasyon dikiş ve kutuplarda yüzeyi kapalı tutar.
      const ripple = 1 + 0.055 * Math.sin(x * 11 + seed) * Math.sin(y * 9 + z * 7)
        + 0.035 * Math.cos(z * 15 - y * 6 + seed);
      positions.setXYZ(i, x * ripple, y * ripple, z * ripple);
    }
    crown.computeVertexNormals();
    return crown;
  }, [seed]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={[0, 0.92, 0]} rotation={[0, seed, 0]}>
      <mesh geometry={geometry} scale={[0.32, 0.39, 0.3]} castShadow receiveShadow>
        <meshStandardMaterial color="#3f783c" roughness={0.88} />
      </mesh>
      {Array.from({ length: 5 }, (_, i) => {
        const angle = i * Math.PI * 2 / 5;
        return (
          <mesh key={i} geometry={geometry}
            position={[Math.cos(angle) * 0.19, (rand(seed, i) - 0.5) * 0.2, Math.sin(angle) * 0.16]}
            scale={[0.22, 0.25 + rand(seed, i + 10) * 0.06, 0.22]} castShadow receiveShadow>
            <meshStandardMaterial color={i % 2 ? "#619647" : "#49813b"} roughness={0.88} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Girişin iki yanında aynı tür, açık gövdeli ve ölçülü taçlı süs ağacı. */
function EntranceTree({ position, seed }: { position: [number, number, number]; seed: number }) {
  return (
    <group position={position} scale={0.62}>
      <RoundedBox args={[0.68, 0.16, 0.68]} radius={0.035} position={[0, 0.08, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#b4afa3" roughness={0.92} />
      </RoundedBox>
      <mesh position={[0, 0.162, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[0.58, 0.58]} />
        <meshStandardMaterial color="#51483b" roughness={1} />
      </mesh>
      <group position={[0, 0.16, 0]}>
        <mesh position={[0.018, 0.34, 0]} rotation={[0, 0, -0.055]} castShadow>
          <cylinderGeometry args={[0.022, 0.038, 0.68, 12]} />
          <meshStandardMaterial color="#786550" roughness={1} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.065, 0.62, 0]} rotation={[0.15 * side, 0, -0.4 * side]} castShadow>
            <cylinderGeometry args={[0.009, 0.019, 0.3, 8]} />
            <meshStandardMaterial color="#786550" roughness={1} />
          </mesh>
        ))}
        <NaturalCrown seed={seed} />
      </group>
    </group>
  );
}

/** Yaya yolunun dışında kalan alçak, küçük saksılı süs çalısı. */
function EntranceShrub({ position, seed }: { position: [number, number, number]; seed: number }) {
  return (
    <group position={position}>
      <RoundedBox args={[0.3, 0.11, 0.3]} radius={0.02} position={[0, 0.055, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#b4afa3" roughness={0.92} />
      </RoundedBox>
      <mesh position={[0, 0.112, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[0.25, 0.25]} />
        <meshStandardMaterial color="#51483b" roughness={1} />
      </mesh>
      <group position={[0, -0.045, 0]} scale={[0.38, 0.27, 0.38]}>
        <NaturalCrown seed={seed} />
      </group>
      {/* Az sayıda küçük çiçek, yaprakların arasına gömülü. */}
      {Array.from({ length: 5 }, (_, i) => {
        const angle = i * Math.PI * 2 / 5 + seed;
        const radius = 0.045 + rand(seed, i + 60) * 0.03;
        return (
          <group key={i} position={[Math.cos(angle) * radius, 0.294 - radius * 0.12, Math.sin(angle) * radius]}>
            {Array.from({ length: 5 }, (_, petal) => {
              const a = petal * Math.PI * 2 / 5;
              return (
                <mesh key={petal} position={[Math.cos(a) * 0.008, 0, Math.sin(a) * 0.008]}
                  rotation={[0, -a, 0]} scale={[1, 0.4, 0.65]}>
                  <sphereGeometry args={[0.009, 8, 6]} />
                  <meshStandardMaterial color={i % 2 ? "#e7c5db" : "#f5eee4"} roughness={0.85} />
                </mesh>
              );
            })}
            <mesh position={[0, 0.003, 0]}>
              <sphereGeometry args={[0.0045, 8, 6]} />
              <meshStandardMaterial color="#d6ad52" roughness={0.9} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** AVM girişi: cepheden dışarı taşan cam rüzgârlık + otomatik sürgülü kapılar,
 * altı LED'li konsol saçak ve AVM adını taşıyan tabela, yoldan kapıya uzanan
 * taş yürüyüş yolu, aydınlatmalı babalar, saksılı ağaçlar ve bankler. Kat
 * planındaki (`plan.entrance`) kapı konumuna göre yerleşir. */
function EntranceFeature({ plan, mallName }: { plan: FloorPlan; mallName: string }) {
  const door = plan.entrance!;
  const D = plan.depth * S;
  const x = (door.x + door.w / 2 - plan.width / 2) * S;
  const fz = D / 2;
  const dw = door.w * S;

  const vestW = dw + 0.3;
  const vestD = 0.55;
  const vestH = 0.92;
  const canopyW = dw + 2.8;
  const canopyD = 1.55;
  const canopyY = 1.04;
  const walkW = dw + 1.2;
  const walkLen = 2.2;
  const frame = { color: MULLION_COLOR, metalness: 0.7, roughness: 0.35 };

  return (
    <group position={[x, 0, fz]}>
      {/* rüzgârlık (cam giriş kutusu) */}
      <group position={[0, 0, vestD / 2]}>
        {[-1, 1].map((side) => (
          <group key={side}>
            <mesh position={[(side * vestW) / 2, vestH / 2, 0]}>
              <boxGeometry args={[0.012, vestH, vestD]} />
              <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.2} metalness={0.9} roughness={0.05} depthWrite={false} />
            </mesh>
            <Box args={[0.04, vestH, 0.04]} position={[(side * vestW) / 2, vestH / 2, vestD / 2]} {...frame} />
          </group>
        ))}
        <mesh position={[0, vestH + 0.01, 0]}>
          <boxGeometry args={[vestW, 0.02, vestD]} />
          <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.25} metalness={0.9} roughness={0.05} depthWrite={false} />
        </mesh>
        <Box args={[vestW, 0.06, 0.05]} position={[0, vestH - 0.02, vestD / 2]} {...frame} />
        <group position={[0, 0, vestD / 2]}>
          <SlidingDoors width={vestW - 0.1} height={vestH - 0.06} />
        </group>
        {/* paspas */}
        <mesh position={[0, 0.004, vestD / 2 + 0.25]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[vestW - 0.1, 0.4]} />
          <meshStandardMaterial color="#27272a" roughness={1} />
        </mesh>
      </group>

      {/* konsol saçak + LED + tabela */}
      <group position={[0, canopyY, canopyD / 2]}>
        <Box args={[canopyW, 0.07, canopyD]} position={[0, 0, 0]} color={PANEL_COLOR} roughness={0.4} metalness={0.1} />
        <mesh position={[0, -0.04, 0]}>
          <boxGeometry args={[canopyW - 0.2, 0.01, canopyD - 0.2]} />
          <meshStandardMaterial color="#fef9c3" emissive="#fef3c7" emissiveIntensity={1.1} toneMapped={false} />
        </mesh>
        <Box args={[canopyW, 0.24, 0.05]} position={[0, 0.07, canopyD / 2]} color="#1d4ed8" metalness={0.2} roughness={0.4} />
        <Text position={[0, 0.07, canopyD / 2 + 0.03]} fontSize={0.15} color="white" anchorX="center" anchorY="middle" fontWeight="bold" letterSpacing={0.06}>
          {mallName.toUpperCase()}
        </Text>
        <Box args={[canopyW, 0.015, 0.055]} position={[0, -0.045, canopyD / 2]} color="#93c5fd" emissiveIntensity={1.2} />
      </group>
      {[-1, 1].map((side) => (
        <Box
          key={side}
          args={[0.05, canopyY, 0.05]}
          position={[side * (canopyW / 2 - 0.2), canopyY / 2, canopyD - 0.15]}
          {...frame}
        />
      ))}

      {/* taş yürüyüş yolu (derzli) + daha geniş meydan */}
      <mesh position={[0, 0.003, walkLen / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[walkW + 3.2, walkLen]} />
        <meshStandardMaterial color="#57534e" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.005, walkLen / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[walkW, walkLen]} />
        <meshStandardMaterial color="#d6d3d1" roughness={0.55} metalness={0.05} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} position={[0, 0.007, 0.15 + i * 0.32]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[walkW, 0.012]} />
          <meshBasicMaterial color="#a8a29e" />
        </mesh>
      ))}

      {/* aydınlatmalı babalar */}
      {[-1, 1].map((side) =>
        Array.from({ length: 4 }, (_, i) => (
          <group key={`${side}-${i}`} position={[(side * walkW) / 2 + side * 0.06, 0, 1.0 + i * 0.36]}>
            <mesh position={[0, 0.07, 0]} castShadow>
              <cylinderGeometry args={[0.025, 0.025, 0.14, 10]} />
              <meshStandardMaterial color={MULLION_COLOR} metalness={0.6} roughness={0.35} />
            </mesh>
            <mesh position={[0, 0.145, 0]}>
              <cylinderGeometry args={[0.026, 0.026, 0.012, 10]} />
              <meshStandardMaterial color="#fef3c7" emissive="#fef3c7" emissiveIntensity={1.5} toneMapped={false} />
            </mesh>
          </group>
        )),
      )}

      {/* saksılı ağaçlar ve bankler */}
      {[-1, 1].map((side) => (
        <group key={side}>
          {/* Taçlar saçaktan ve yaya aksından uzakta; iki ağaç girişe çerçeve olur. */}
          <EntranceTree position={[side * (canopyW / 2 + 0.52), 0, 0.62]} seed={side === 1 ? 17 : 29} />
          <EntranceShrub position={[side * (walkW / 2 + 0.45), 0, 1.8]} seed={side === 1 ? 41 : 53} />
          <RoundedBox args={[0.6, 0.08, 0.2]} radius={0.02} position={[side * (walkW / 2 + 0.75), 0.13, 1.2]} castShadow>
            <meshStandardMaterial color="#a16207" roughness={0.7} />
          </RoundedBox>
          {[-0.22, 0.22].map((lx) => (
            <mesh key={lx} position={[side * (walkW / 2 + 0.75) + lx, 0.045, 1.2]}>
              <boxGeometry args={[0.04, 0.09, 0.18]} />
              <meshStandardMaterial color={MULLION_COLOR} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Tek parça bariyer kolu yolun tamamını kapatır ve tek menteşeden yükselir. */
function ParkingBarrier({ position, side, label }: {
  position: [number, number, number]; side: number; label: string;
}) {
  const [open, setOpen] = useState(false);
  const arm = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (arm.current) arm.current.rotation.z = THREE.MathUtils.damp(
      arm.current.rotation.z, open ? -side * Math.PI * 0.46 : 0, 5, delta,
    );
  });
  return (
    <group position={position} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
      <Box args={[0.11, 0.28, 0.13]} position={[0, 0.14, 0]} color="#52606b" />
      <Box args={[0.065, 0.045, 0.009]} position={[0, 0.2, 0.07]}
        color={open ? "#66b58a" : "#d97c69"} emissiveIntensity={0.25} />
      <group ref={arm} position={[0, 0.3, 0]}>
        <Box args={[1.46, 0.035, 0.035]} position={[-side * 0.73, 0, 0]} color="#f1eee6" />
        {[0.14, 0.36, 0.58, 0.8, 1.02, 1.24, 1.4].map((offset) => (
          <Box key={offset} args={[0.055, 0.037, 0.038]} position={[-side * offset, 0, 0]} color="#bb5549" />
        ))}
      </group>
      <Text position={[-side * 0.73, 0.57, 0]} fontSize={0.07} color="#e2e8f0" anchorX="center">
        {label}
      </Text>
      <Html position={[0, 0.05, 0.1]} center distanceFactor={9}>
        <button type="button" aria-label={`${label} bariyerini ${open ? "kapat" : "aç"}`}
          aria-pressed={open} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
          className="rounded border border-white/20 bg-slate-900/90 px-1.5 py-0.5 text-[9px] whitespace-nowrap text-white">
          {open ? "Kapat" : "Aç"}
        </button>
      </Html>
    </group>
  );
}

/** Yan cephede yoldan bodrum seviyesine inen araç girişi. */
function ParkingEntrance({ plan, parking }: { plan: FloorPlan; parking: FloorPlan }) {
  const x = plan.width * S / 2 + 1;
  const front = plan.depth * S / 2 + 2.2;
  const corridor = parking.corridor;
  const turnZ = corridor ? center(corridor, parking)[1] : 0;
  const turnRadius = 0.65;
  const rampEnd = turnZ + turnRadius;
  const run = front - rampEnd;
  const drop = -floorY(parking.levelOrder);
  const wallX = plan.width * S / 2;
  const laneWidth = corridor ? Math.min(0.8, corridor.d * S * 0.9) : 0.75;
  const turnPath = new THREE.CatmullRomCurve3(
    Array.from({ length: 17 }, (_, i) => {
      const angle = i / 16 * Math.PI / 2;
      return new THREE.Vector3(x - turnRadius + turnRadius * Math.cos(angle),
        -drop + 0.012, rampEnd - turnRadius * Math.sin(angle));
    }),
  );
  const length = Math.hypot(run, drop);
  const angle = -Math.atan2(drop, run);
  return (
    <group>
      <group position={[x, -drop / 2, front - run / 2]} rotation={[angle, 0, 0]}>
        <Box args={[1.6, 0.09, length]} position={[0, -0.045, 0]} color="#454952" />
        {[-1, 1].map((side) => (
          <group key={side}>
            <Box args={[0.09, 0.32, length]} position={[side * 0.8, 0.12, 0]} color="#a8a7a2" />
            <Box args={[0.035, 0.008, length - 0.12]} position={[side * 0.65, 0.008, 0]} color="#e9ddaa" />
          </group>
        ))}
        {[-1.6, -0.6, 0.4, 1.4].map((z) => (
          <Box key={z} args={[0.035, 0.008, 0.42]} position={[0, 0.009, z]} color="#e8e5db" />
        ))}
      </group>
      {/* Geniş düz sahanlık: rampadan inen araç sola dönerek gerçek araç koridoruna girer. */}
      <Box args={[1.85, 0.09, turnRadius + laneWidth / 2]}
        position={[wallX + 0.925, -drop - 0.045, rampEnd - (turnRadius + laneWidth / 2) / 2]} color="#454952" />
      <Box args={[1.6, 0.035, laneWidth]}
        position={[wallX - 0.45, -drop - 0.012, turnZ]} color="#454952" />
      <Box args={[0.08, 0.25, turnRadius + laneWidth / 2]}
        position={[wallX + 1.85, -drop + 0.1, rampEnd - (turnRadius + laneWidth / 2) / 2]} color="#a8a7a2" />
      <Box args={[1.85, 0.25, 0.08]}
        position={[wallX + 0.925, -drop + 0.1, turnZ - laneWidth / 2]} color="#a8a7a2" />
      {/* Kavisli yön çizgisi ve koridora bakan ok; iç bağlantı açık bırakılır. */}
      <mesh>
        <tubeGeometry args={[turnPath, 24, 0.012, 5, false]} />
        <meshStandardMaterial color="#e9ddaa" roughness={0.9} />
      </mesh>
      <Box args={[0.85, 0.008, 0.028]} position={[wallX - 0.05, -drop + 0.014, turnZ]} color="#e9ddaa" />
      {[-1, 1].map((side) => (
        <group key={`arrow-${side}`} position={[wallX - 0.43, -drop + 0.014, turnZ + side * 0.055]} rotation={[0, side * -Math.PI / 4, 0]}>
          <Box args={[0.16, 0.008, 0.025]} position={[0, 0, 0]} color="#e9ddaa" />
        </group>
      ))}
      {[-1, 1].map((side) => (
        <Box key={side} args={[0.065, 0.82, 0.065]} position={[x + side * 0.8, 0.41, front - 0.08]} color="#505966" metalness={0.5} />
      ))}
      <Box args={[1.72, 0.25, 0.12]} position={[x, 0.83, front - 0.08]} color="#1e4563" />
      <Text position={[x, 0.83, front - 0.012]} fontSize={0.115} color="#f3f6f8" anchorX="center" anchorY="middle">
        P  OTOPARK
      </Text>
      {/* Her iki şeridi tek kesintisiz kol kapatır. */}
      <ParkingBarrier position={[x + 0.73, 0, front + 0.12]} side={1} label="GİRİŞ / ÇIKIŞ" />
    </group>
  );
}

/** Bina çevresi: bodrum görünsün diye binanın altında açıklık bırakan zemin, giriş önünde meydan. */
function Surroundings({ plan, cutaway, parking }: { plan: FloorPlan; cutaway: boolean; parking?: FloorPlan }) {
  const W = plan.width * S;
  const D = plan.depth * S;
  const size = Math.max(W, D) + 10;
  const gx = W / 2 + 0.15;
  const gz = D / 2 + 0.15;
  const color = "#2a2e3d";
  // bodrum (otopark) incelenirken çevre zemin neredeyse saydam — görüşü kapatmasın
  const ground = { color, opacity: cutaway ? 0.12 : 0.6 };
  const y = -0.06;
  const groundRects = [
    { x: -size / 2, z: gz, w: size, d: size / 2 - gz },
    { x: -size / 2, z: -size / 2, w: size, d: size / 2 - gz },
    { x: gx, z: -gz, w: size / 2 - gx, d: 2 * gz },
    { x: -size / 2, z: -gz, w: size / 2 - gx, d: 2 * gz },
  ];
  // Rampanın üstünü zeminle kapatmamak için çevre döşemesinden açıklık çıkar.
  const turnZ = parking?.corridor ? center(parking.corridor, parking)[1] : 0;
  const slot = { x: W / 2, z: turnZ - 0.5, w: 1.95, d: D / 2 + 2.2 - (turnZ - 0.5) };
  const pieces = groundRects.flatMap((r) => {
    if (!parking) return [r];
    const x0 = Math.max(r.x, slot.x), x1 = Math.min(r.x + r.w, slot.x + slot.w);
    const z0 = Math.max(r.z, slot.z), z1 = Math.min(r.z + r.d, slot.z + slot.d);
    if (x0 >= x1 || z0 >= z1) return [r];
    return [
      { x: r.x, z: r.z, w: x0 - r.x, d: r.d },
      { x: x1, z: r.z, w: r.x + r.w - x1, d: r.d },
      { x: x0, z: r.z, w: x1 - x0, d: z0 - r.z },
      { x: x0, z: z1, w: x1 - x0, d: r.z + r.d - z1 },
    ].filter((part) => part.w > 0.001 && part.d > 0.001);
  });
  return (
    <>
      {pieces.map((r, i) => (
        <Box key={i} args={[r.w, 0.1, r.d]} position={[r.x + r.w / 2, y, r.z + r.d / 2]} {...ground} />
      ))}
      {parking && <ParkingEntrance plan={plan} parking={parking} />}
      {/* yol */}
      <mesh position={[0, 0.002, D / 2 + 3.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size, 2]} />
        <meshStandardMaterial color="#3d4152" roughness={0.95} />
      </mesh>
      {Array.from({ length: 10 }, (_, i) => (
        <mesh key={i} position={[-size / 2 + (i + 0.5) * (size / 10), 0.004, D / 2 + 3.2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.45, 0.05]} />
          <meshBasicMaterial color="#e4e4e7" />
        </mesh>
      ))}
    </>
  );
}

type Vec3 = [number, number, number];
type CameraView = { target: Vec3; position: Vec3 };

/** Binanın doğu cephesi yanında, her katın hizasında tıklanabilir kat etiketi —
 * üst katlar görüşü kapatsa bile (ör. bodrum otopark) her kata tek tıkla ulaşılır. */
function FloorTags({
  plans,
  active,
  onOpen,
}: {
  plans: FloorPlan[];
  active: number | null;
  onOpen: (level: number) => void;
}) {
  return (
    <>
      {plans.map((p) => (
        <Html key={p.levelOrder} position={[(p.width / 2) * S + 0.55, floorY(p.levelOrder) + 0.35, (p.depth / 2) * S]} center>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(p.levelOrder);
            }}
            className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] shadow-lg transition-colors ${
              active === p.levelOrder
                ? "border-blue-400/70 bg-blue-500/30 text-white"
                : "border-white/20 bg-neutral-950/80 text-neutral-300 hover:text-white hover:bg-neutral-900"
            }`}
          >
            {p.name}
          </button>
        </Html>
      ))}
    </>
  );
}

/** Kamerayı (bakış noktası + konum) yumuşakça verilen görünüme taşır. Geçiş
 * sadece `focusKey` değişince (kat/bölge seçimi, boşluğa tıklama) başlar ve
 * hedefe varınca durur — sonrasında kullanıcı serbestçe döndürüp
 * yakınlaştırabilir, her veri güncellemesinde kamera geri çekilmez. */
function CameraRig({ view, focusKey }: { view: CameraView; focusKey: string }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef<CameraView | null>(null);
  useEffect(() => {
    goal.current = view;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: sadece seçim değişince
  }, [focusKey]);
  useFrame(() => {
    if (!controls || !goal.current) return;
    const t = new THREE.Vector3(...goal.current.target);
    const p = new THREE.Vector3(...goal.current.position);
    controls.target.lerp(t, 0.09);
    camera.position.lerp(p, 0.09);
    controls.update();
    if (controls.target.distanceTo(t) < 0.01 && camera.position.distanceTo(p) < 0.01) goal.current = null;
  });
  return null;
}

const OVERVIEW_OFFSET: Vec3 = [8.5, 5.5, 10.5];
const FLOOR_OFFSET: Vec3 = [6.2, 4.6, 7.6];

export function MallBuilding3D({
  zones,
  mallSlug,
  anomalyCodes,
  predictions,
  storesByZone,
  mallName = "AVM",
}: {
  zones: ZoneOccupancy[];
  mallSlug: string;
  mallName?: string;
  anomalyCodes: Set<string>;
  predictions?: Record<string, ZonePrediction>;
  storesByZone?: Record<string, string[]>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // null = tüm bina; bir kat seçilince ÜSTÜNDEKİ katlar ve çatı gizlenir (içi görünsün)
  const [floorChoice, setFloorChoice] = useState<number | null>(null);
  const plans = useMemo(() => buildFloorPlans(mallSlug, zones), [mallSlug, zones]);
  if (plans.length === 0) return null;

  const retail = plans.filter((p) => !p.isParking);
  const minLevel = plans[0].levelOrder;
  const maxLevel = plans[plans.length - 1].levelOrder;
  const shownMax = floorChoice ?? maxLevel;
  const visible = plans.filter((p) => p.levelOrder <= shownMax);
  const ref = plans.find((p) => p.levelOrder === 0) ?? plans[0];
  const parkingBelow = plans.find((p) => p.isParking && p.levelOrder === ref.levelOrder - 1);
  // Araç koridorunun kuzeyindeki boş şerit; üst katta mağaza veya girişle çakışmaz.
  const pedestrianBay = parkingBelow?.units.find((u) => !u.zone && (u.style === "vacant" || u.style === "service") && u.w >= 1.8 && u.d >= 5
    && parkingBelow.corridor && u.z + u.d <= parkingBelow.corridor.z + 0.01
    && !ref.units.some((upper) => upper.style !== "vacant" && overlaps({ x: u.x + 0.1, z: u.z + 0.5, w: u.w - 0.2, d: u.d - 1.5 }, upper)));
  const parkingConnection: Rect | undefined = pedestrianBay
    ? { x: pedestrianBay.x + 0.1, z: pedestrianBay.z + 0.5, w: pedestrianBay.w - 0.2, d: pedestrianBay.d - 1.5 }
    : undefined;
  const selectedZone = zones.find((z) => z.code === selected) ?? null;
  const selectedUnit = selected ? plans.flatMap((p) => p.units.map((u) => ({ u, p }))).find(({ u }) => u.zone?.code === selected) : undefined;
  let view: CameraView;
  if (selectedUnit) {
    // Bölgeye vitrin (koridor) tarafından, hafif yukarıdan bak — bölme duvarları
    // görüşü kapatmasın. Mesafe bölgenin büyüklüğüne göre: küçük bölge yakından.
    const { u, p } = selectedUnit;
    const [ux, uz] = center(u, p);
    const size = Math.max(u.w, u.d) * S;
    const dist = Math.min(6, Math.max(2.2, size * 1.7 + 1.1));
    const side = frontSide(u, p);
    // Tüm bölgelere (otopark dahil) AYNI açıyla (~37°) bakılır. Bodrumda görüşü
    // kapatabilecek üst katlar gizli, çevre zemin de neredeyse saydam (cutaway).
    const dir = side === "south" ? [0.35, 0.8, 1] : side === "north" ? [0.35, 0.8, -1] : [0.75, 0.8, 0.75];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const target: Vec3 = [ux, floorY(p.levelOrder) + 0.25, uz];
    view = { target, position: [target[0] + (dir[0] / len) * dist, target[1] + (dir[1] / len) * dist, target[2] + (dir[2] / len) * dist] };
  } else if (floorChoice !== null) {
    const target: Vec3 = [0, floorY(floorChoice) + 0.3, 0];
    view = { target, position: [FLOOR_OFFSET[0], target[1] + FLOOR_OFFSET[1], FLOOR_OFFSET[2]] };
  } else {
    const target: Vec3 = [0, ((minLevel + maxLevel + 1) * LEVEL_H) / 2, 0];
    view = { target, position: [OVERVIEW_OFFSET[0], target[1] + OVERVIEW_OFFSET[1] - 1.2, OVERVIEW_OFFSET[2]] };
  }
  const openFloor = (level: number) => {
    setFloorChoice(level);
    setSelected(null);
  };
  // Bölge hangi kattaysa o kat açılır (üstündekiler gizlenir) ve bölgeye zoom yapılır —
  // başka bir kattaki bölgeye geçerken de. Seçili bölgeye tekrar tıklamak seçimi kaldırır.
  const selectZone = (code: string | null) => {
    if (code === null || code === selected) {
      setSelected(null);
      return;
    }
    const level = plans.find((p) => p.units.some((u) => u.zone?.code === code))?.levelOrder;
    if (level !== undefined) setFloorChoice(level);
    setSelected(code);
  };
  // Boşluğa tıklama, bölge ve kat odağını birlikte kaldırıp tüm binaya döner.
  const resetView = () => {
    setSelected(null);
    setFloorChoice(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FloorButton
          active={floorChoice === null}
          onClick={() => {
            setFloorChoice(null);
            setSelected(null);
          }}
        >
          Tüm bina
        </FloorButton>
        {[...plans].reverse().map((p) => (
          <FloorButton key={p.levelOrder} active={floorChoice === p.levelOrder} onClick={() => openFloor(p.levelOrder)}>
            {p.name}
          </FloorButton>
        ))}
      </div>
      <div className="relative h-[720px] rounded-xl border border-white/15 bg-white/[0.05] overflow-hidden">
        {selectedZone && (
          <ZoneDetailCard
            zone={selectedZone}
            anomaly={anomalyCodes.has(selectedZone.code)}
            prediction={predictions?.[selectedZone.code]}
            stores={storesByZone?.[selectedZone.code]}
            onClose={() => setSelected(null)}
            className="absolute top-3 right-3 z-10 w-72"
          />
        )}
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [8.5, 5.5, 10.5], fov: 38 }}
          onPointerMissed={resetView}
        >
          <color attach="background" args={["#0a0f1e"]} />
          <fog attach="fog" args={["#0a0f1e", 22, 45]} />
          <ambientLight intensity={0.35} />
          <hemisphereLight color="#dbeafe" groundColor="#1e1b2e" intensity={0.55} />
          <directionalLight
            position={[7, 12, 9]}
            intensity={1.6}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0004}
            shadow-camera-left={-9}
            shadow-camera-right={9}
            shadow-camera-top={9}
            shadow-camera-bottom={-9}
          />
          <directionalLight position={[-6, 5, -4]} intensity={0.35} color="#c7d2fe" />
          {/* cam/metal yüzeylerin yansıması için yumuşak stüdyo ışıkları (HDR indirmez, çevrimdışı) */}
          <Environment resolution={256} frames={1}>
            <Lightformer intensity={1.6} position={[0, 6, -10]} scale={[20, 6, 1]} color="#e0f2fe" />
            <Lightformer intensity={0.8} position={[10, 3, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[12, 4, 1]} color="#fde68a" />
            <Lightformer intensity={0.6} position={[-10, 3, 0]} rotation={[0, Math.PI / 2, 0]} scale={[12, 4, 1]} color="#c7d2fe" />
            <Lightformer intensity={1.2} position={[0, 10, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
          </Environment>

          {/* Çevre zemine tıklama yakalayıcı KONMADI: bodrum otopark zeminin altında
              kaldığı için yakalayıcı arkadaki otopark bölgelerine giden tıklamaları
              yutuyordu. Boş alana tıklama zaten `onPointerMissed` ile (hiçbir
              tıklanabilir nesneye çarpmayınca) geri dönüşü tetikliyor. */}
          <Surroundings plan={ref} cutaway={floorChoice !== null && floorChoice < 0} parking={plans.filter((p) => p.isParking && p.levelOrder < 0).at(-1)} />
          {ref.entrance && ref.levelOrder === 0 && shownMax >= 0 && <EntranceFeature plan={ref} mallName={mallName} />}

          {visible.map((plan) => (
            <FloorLevel
              key={plan.levelOrder}
              plan={plan}
              selected={selected}
              anomalyCodes={anomalyCodes}
              onSelect={selectZone}
              onFloorClick={() => selected ? resetView() : openFloor(plan.levelOrder)}
              hasCeiling={floorChoice === null || plan.levelOrder < shownMax}
              opening={plan.levelOrder === ref.levelOrder ? parkingConnection : undefined}
              pedestrianBay={parkingConnection && (plan === ref || plan === parkingBelow) ? pedestrianBay : undefined}
            />
          ))}

          {/* Otopark tek başına açıkken de zemin kata uzanan bağlantı görünür. */}
          {parkingBelow && parkingConnection && shownMax >= parkingBelow.levelOrder && (
            <group>
              <Escalators plan={{ ...ref, atrium: parkingConnection }} fromLevel={parkingBelow.levelOrder} alongZ />
              <ParkingPedestrianBay plan={parkingBelow} bay={pedestrianBay!} />
              {shownMax >= ref.levelOrder && [-1, 1].map((side) => (
                <Box key={`landing-rail-${side}`}
                  args={[0.025, RAIL_H, parkingConnection.d * S]}
                  position={[(parkingConnection.x + parkingConnection.w / 2 - ref.width / 2) * S + side * parkingConnection.w * S / 2,
                    floorY(ref.levelOrder) + RAIL_H / 2, (parkingConnection.z + parkingConnection.d / 2 - ref.depth / 2) * S]}
                  color={GLASS_COLOR} opacity={0.4} />
              ))}
            </group>
          )}

          {/* yürüyen merdivenler: görünen her mağaza katından bir üstüne */}
          {retail
            .filter((p) => p.atrium && p.levelOrder < maxLevel && p.levelOrder + 1 <= shownMax)
            .map((p) => (
              <Escalators key={p.levelOrder} plan={p} fromLevel={p.levelOrder} />
            ))}

          {visible.map((plan) => (
            <Facade
              key={`f-${plan.levelOrder}`}
              plan={plan}
              y={floorY(plan.levelOrder)}
              height={floorChoice !== null && plan.levelOrder === shownMax ? PARTITION_H + 0.25 : LEVEL_H - SLAB_T}
            />
          ))}

          {floorChoice === null && <Roof plan={plans[plans.length - 1]} y={floorY(maxLevel) + LEVEL_H - SLAB_T} mallName={mallName} />}

          <OrbitControls makeDefault enablePan={false} minDistance={3} maxDistance={24} maxPolarAngle={Math.PI / 1.75} />
          <FloorTags plans={plans} active={floorChoice} onOpen={openFloor} />
          <CameraRig view={view} focusKey={`${floorChoice}|${selected}`} />
        </Canvas>
      </div>
    </div>
  );
}

function FloorButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active ? "border-blue-500/50 bg-blue-500/15 text-white" : "border-white/15 text-neutral-400 hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
