/** Değişim rozeti (Raporlar). `goodWhenUp`: artış iyi mi (ziyaretçi → yeşil)
 * yoksa kötü mü (uyarı → turuncu). `against`: neye göre ("geçen haftaya göre"). */
export function Delta({
  value,
  against,
  goodWhenUp = true,
}: {
  value: number | null;
  against: string;
  goodWhenUp?: boolean;
}) {
  if (value == null) return <span className="text-xs text-neutral-500">kıyas yok</span>;
  const flat = Math.abs(value) < 0.5;
  const good = flat ? null : value > 0 === goodWhenUp;
  const cls = flat ? "bg-white/10 text-neutral-300" : good ? "bg-emerald-500/15 text-emerald-300" : "bg-orange-500/15 text-orange-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${cls}`}>
      {flat ? "→" : value > 0 ? "↑" : "↓"} %{Math.abs(value).toFixed(1)}
      <span className="font-normal opacity-70">{against}</span>
    </span>
  );
}
