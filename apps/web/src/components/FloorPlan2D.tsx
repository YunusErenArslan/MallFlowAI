"use client";

import { ANOMALY_HEX, LEVEL_HEX } from "@/lib/level";
import { type FloorPlan, type PlacedUnit, parkingBays, peopleInUnit } from "@/lib/mall-layout";

// Modern mimari plan dili: koyu lacivert zemin plakası, ince çizgiler, yuvarlak
// köşeli birimler, doluluk rengi yumuşak dolgu + LED gibi parlayan kenar/şerit.
// 3D Görünüm ile aynı plan tanımı ve aynı renkler.
const PLATE = "#0f172a";
const PLATE_STROKE = "#334155";
const CORRIDOR = "#1e293b";
const GRID = "#243349";
const VACANT_STROKE = "#334155";
const GLASS = "#7dd3fc";
const TEXT = "#f8fafc";
const MUTED = "#94a3b8";
const MARGIN = 1.4;
const RADIUS = 0.35;
const GAP = 0.12; // birimler arası derz

/** Birimin galeri koridoruna bakan kenarı — vitrin (cam cephe) orada çizilir. */
function frontEdge(unit: PlacedUnit, plan: FloorPlan): "north" | "south" | null {
  const c = plan.corridor;
  if (!c) return null;
  if (unit.z + unit.d <= c.z + 0.01) return "south";
  if (unit.z >= c.z + c.d - 0.01) return "north";
  return null;
}

function UnitDecor({ unit, color }: { unit: PlacedUnit; color: string }) {
  const { x, z, w, d } = unit;
  if (unit.style === "escalator") {
    const bandW = w * 0.26;
    return (
      <g opacity={0.8}>
        {[x + w * 0.16, x + w * 0.58].map((bx, k) => (
          <g key={bx}>
            <rect x={bx} y={z + d * 0.18} width={bandW} height={d * 0.64} rx={0.12} fill="none" stroke={MUTED} strokeWidth={0.05} />
            <path
              d={`M ${bx + bandW / 2} ${z + d * (k === 0 ? 0.7 : 0.3)} l 0 ${d * (k === 0 ? -0.36 : 0.36)} m -0.18 ${k === 0 ? 0.2 : -0.2} l 0.18 ${k === 0 ? -0.2 : 0.2} l 0.18 ${k === 0 ? 0.2 : -0.2}`}
              fill="none"
              stroke={MUTED}
              strokeWidth={0.06}
              strokeLinecap="round"
            />
          </g>
        ))}
      </g>
    );
  }
  if (unit.style === "food_court") {
    const cols = Math.max(2, Math.floor(w / 1.8));
    const rows = Math.max(1, Math.floor(d / 1.8));
    return (
      <g opacity={0.45}>
        {Array.from({ length: cols * rows }, (_, i) => {
          const cx = x + ((i % cols) + 0.5) * (w / cols);
          const cy = z + (Math.floor(i / cols) + 0.5) * (d / rows);
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={0.28} fill="none" stroke={color} strokeWidth={0.05} />
              {[0, 1, 2, 3].map((a) => (
                <circle key={a} cx={cx + Math.cos((a * Math.PI) / 2) * 0.48} cy={cy + Math.sin((a * Math.PI) / 2) * 0.48} r={0.08} fill={color} />
              ))}
            </g>
          );
        })}
      </g>
    );
  }
  if (unit.style === "cinema") {
    return (
      <g opacity={0.6}>
        <path
          d={`M ${x + w * 0.12} ${z + 0.55} Q ${x + w / 2} ${z + 0.25} ${x + w * 0.88} ${z + 0.55}`}
          fill="none"
          stroke={TEXT}
          strokeWidth={0.1}
          strokeLinecap="round"
        />
        {Array.from({ length: 4 }, (_, i) => (
          <path
            key={i}
            d={`M ${x + w * 0.2} ${z + d * (0.42 + i * 0.12)} Q ${x + w / 2} ${z + d * (0.38 + i * 0.12)} ${x + w * 0.8} ${z + d * (0.42 + i * 0.12)}`}
            fill="none"
            stroke={MUTED}
            strokeWidth={0.05}
            strokeDasharray="0.18 0.1"
          />
        ))}
      </g>
    );
  }
  return null;
}

function Unit({
  unit,
  plan,
  selected,
  anomaly,
  onSelect,
}: {
  unit: PlacedUnit;
  plan: FloorPlan;
  selected: boolean;
  anomaly: boolean;
  onSelect: (code: string | null) => void;
}) {
  const x = unit.x + GAP;
  const z = unit.z + GAP;
  const w = unit.w - 2 * GAP;
  const d = unit.d - 2 * GAP;
  const zone = unit.zone;
  const r = Math.min(RADIUS, w / 4, d / 4);

  if (!zone) {
    return (
      <rect x={x} y={z} width={w} height={d} rx={r} fill="none" stroke={VACANT_STROKE} strokeWidth={0.05} strokeDasharray="0.25 0.15" />
    );
  }

  const color = zone.level ? LEVEL_HEX[zone.level] : "#64748b";
  const front = frontEdge(unit, plan);
  const small = w * d < 8;
  const people = peopleInUnit(unit);
  const pct = zone.occupancy_pct;

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onSelect(selected ? null : zone.code);
      }}
      className="cursor-pointer [&:hover>.unit-fill]:[fill-opacity:0.3]"
    >
      <rect
        className="unit-fill transition-[fill-opacity]"
        x={x}
        y={z}
        width={w}
        height={d}
        rx={r}
        fill={`url(#fill-${zone.level ?? "none"})`}
        fillOpacity={selected ? 0.34 : 0.2}
        stroke={color}
        strokeOpacity={0.85}
        strokeWidth={selected ? 0.12 : 0.06}
        filter={selected ? "url(#glow)" : undefined}
      />
      <UnitDecor unit={unit} color={color} />

      {unit.style === "parking" &&
        parkingBays(unit).map((bay, i) => (
          <g key={i}>
            <line x1={bay.x} x2={bay.x} y1={bay.z + 0.15} y2={bay.z + bay.d - 0.15} stroke={MUTED} strokeOpacity={0.35} strokeWidth={0.04} />
            {bay.filled && (
              <rect
                x={bay.x + bay.w * 0.2}
                y={bay.z + bay.d * 0.16}
                width={bay.w * 0.6}
                height={bay.d * 0.68}
                rx={0.22}
                fill={TEXT}
                fillOpacity={0.55}
              />
            )}
          </g>
        ))}

      {people.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.z} r={0.11} fill={color} fillOpacity={0.95} />
      ))}

      {front && (
        // vitrin: koridora bakan kenarda parlayan cam şerit
        <line
          x1={x + r}
          x2={x + w - r}
          y1={front === "south" ? z + d : z}
          y2={front === "south" ? z + d : z}
          stroke={GLASS}
          strokeWidth={0.1}
          strokeLinecap="round"
          filter="url(#glow)"
        />
      )}

      {anomaly && (
        <rect
          x={x - 0.18}
          y={z - 0.18}
          width={w + 0.36}
          height={d + 0.36}
          rx={r + 0.18}
          fill="none"
          stroke={ANOMALY_HEX}
          strokeWidth={0.16}
          filter="url(#glow)"
          className="animate-pulse"
        />
      )}

      {/* etiket: ad + doluluk rozeti */}
      <g style={{ pointerEvents: "none" }}>
        <text
          x={x + w / 2}
          y={z + d / 2 - (small ? 0.05 : 0.3)}
          textAnchor="middle"
          fill={TEXT}
          fontSize={small ? 0.4 : 0.55}
          fontWeight={600}
          letterSpacing={0.01}
        >
          {zone.name}
        </text>
        <rect
          x={x + w / 2 - (small ? 0.75 : 1.05)}
          y={z + d / 2 + (small ? 0.12 : 0.05)}
          width={small ? 1.5 : 2.1}
          height={small ? 0.55 : 0.78}
          rx={small ? 0.275 : 0.39}
          fill={color}
          fillOpacity={0.22}
          stroke={color}
          strokeOpacity={0.6}
          strokeWidth={0.04}
        />
        <text
          x={x + w / 2}
          y={z + d / 2 + (small ? 0.53 : 0.64)}
          textAnchor="middle"
          fill={color}
          fontSize={small ? 0.4 : 0.56}
          fontWeight={700}
        >
          {pct != null ? `%${pct.toFixed(0)}` : "—"}
        </text>
      </g>
    </g>
  );
}

/** Tek bir katın üstten görünüşlü plan çizimi — 3D Görünüm ile AYNI plan
 * tanımından (`lib/mall-layout.ts`). */
export function FloorPlan2D({
  plan,
  selected,
  anomalyCodes,
  onSelect,
}: {
  plan: FloorPlan;
  selected: string | null;
  anomalyCodes: Set<string>;
  onSelect: (code: string | null) => void;
}) {
  const { width, depth, corridor, atrium, entrance, ramp } = plan;
  const upperFloor = plan.levelOrder > 0;

  return (
    <svg
      viewBox={`${-MARGIN} ${-MARGIN} ${width + 2 * MARGIN} ${depth + 2 * MARGIN + 0.6}`}
      className="w-full h-auto select-none"
      onClick={() => onSelect(null)}
      role="img"
      aria-label={`${plan.name} kat planı`}
      fontFamily="inherit"
    >
      <defs>
        <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke={GRID} strokeWidth={0.02} />
        </pattern>
        <pattern id="hatch" width="0.4" height="0.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.4" stroke={PLATE_STROKE} strokeWidth={0.05} />
        </pattern>
        {Object.entries(LEVEL_HEX).map(([level, hex]) => (
          <linearGradient key={level} id={`fill-${level}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={hex} stopOpacity={1} />
            <stop offset="100%" stopColor={hex} stopOpacity={0.55} />
          </linearGradient>
        ))}
        <linearGradient id="fill-none" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#64748b" />
          <stop offset="100%" stopColor="#64748b" stopOpacity={0.55} />
        </linearGradient>
        <radialGradient id="atrium-glow" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor={GLASS} stopOpacity={0.22} />
          <stop offset="100%" stopColor={GLASS} stopOpacity={0} />
        </radialGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.12" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="plate-shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="0.35" stdDeviation="0.45" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>

      {/* kat plakası */}
      <rect x={0} y={0} width={width} height={depth} rx={0.6} fill={PLATE} stroke={PLATE_STROKE} strokeWidth={0.08} filter="url(#plate-shadow)" />
      <rect x={0} y={0} width={width} height={depth} rx={0.6} fill="url(#grid)" />

      {corridor && <rect x={corridor.x + 0.1} y={corridor.z} width={corridor.w - 0.2} height={corridor.d} fill={CORRIDOR} />}

      {plan.isParking && corridor && (
        <g opacity={0.55}>
          <line
            x1={0.6}
            x2={width - 0.6}
            y1={corridor.z + corridor.d / 2}
            y2={corridor.z + corridor.d / 2}
            stroke={MUTED}
            strokeWidth={0.05}
            strokeDasharray="0.6 0.4"
          />
          {Array.from({ length: Math.floor(width / 5) }, (_, i) => (
            <path
              key={i}
              d={`M ${2.5 + i * 5} ${corridor.z + corridor.d * 0.28} l 0.7 0 m -0.25 -0.22 l 0.25 0.22 l -0.25 0.22`}
              fill="none"
              stroke={TEXT}
              strokeWidth={0.07}
              strokeLinecap="round"
            />
          ))}
        </g>
      )}

      {atrium &&
        (upperFloor ? (
          <g>
            <rect x={atrium.x} y={atrium.z} width={atrium.w} height={atrium.d} rx={0.5} fill="#020617" />
            <rect x={atrium.x} y={atrium.z} width={atrium.w} height={atrium.d} rx={0.5} fill="url(#atrium-glow)" />
            <rect
              x={atrium.x}
              y={atrium.z}
              width={atrium.w}
              height={atrium.d}
              rx={0.5}
              fill="none"
              stroke={GLASS}
              strokeWidth={0.08}
              filter="url(#glow)"
            />
            <text x={atrium.x + atrium.w / 2} y={atrium.z + atrium.d / 2 + 0.18} textAnchor="middle" fill={MUTED} fontSize={0.42} letterSpacing={0.08}>
              ATRİYUM
            </text>
          </g>
        ) : (
          <rect
            x={atrium.x}
            y={atrium.z}
            width={atrium.w}
            height={atrium.d}
            rx={0.5}
            fill="url(#atrium-glow)"
            stroke={GLASS}
            strokeOpacity={0.45}
            strokeWidth={0.05}
            strokeDasharray="0.3 0.2"
          />
        ))}

      {ramp && (
        <g>
          <rect x={ramp.x + GAP} y={ramp.z + GAP} width={ramp.w - 2 * GAP} height={ramp.d - 2 * GAP} rx={RADIUS} fill="url(#hatch)" stroke={PLATE_STROKE} strokeWidth={0.05} />
          <text x={ramp.x + ramp.w / 2} y={ramp.z + ramp.d / 2 + 0.2} textAnchor="middle" fill={MUTED} fontSize={0.5} letterSpacing={0.06}>
            RAMPA ↑
          </text>
        </g>
      )}

      {plan.units.map((unit, i) => (
        <Unit
          key={unit.zone?.code ?? `vacant-${i}`}
          unit={unit}
          plan={plan}
          selected={!!unit.zone && unit.zone.code === selected}
          anomaly={!!unit.zone && anomalyCodes.has(unit.zone.code)}
          onSelect={onSelect}
        />
      ))}

      {entrance && (
        <g>
          <line x1={entrance.x} x2={entrance.x + entrance.w} y1={entrance.z} y2={entrance.z} stroke={PLATE} strokeWidth={0.2} />
          <line
            x1={entrance.x + 0.15}
            x2={entrance.x + entrance.w - 0.15}
            y1={entrance.z}
            y2={entrance.z}
            stroke={GLASS}
            strokeWidth={0.1}
            strokeLinecap="round"
            filter="url(#glow)"
          />
          <rect
            x={entrance.x + entrance.w / 2 - 1.1}
            y={entrance.z + 0.4}
            width={2.2}
            height={0.7}
            rx={0.35}
            fill={CORRIDOR}
            stroke={GLASS}
            strokeOpacity={0.6}
            strokeWidth={0.04}
          />
          <text x={entrance.x + entrance.w / 2} y={entrance.z + 0.9} textAnchor="middle" fill={TEXT} fontSize={0.4} fontWeight={600} letterSpacing={0.08}>
            ↑ GİRİŞ
          </text>
        </g>
      )}
    </svg>
  );
}
