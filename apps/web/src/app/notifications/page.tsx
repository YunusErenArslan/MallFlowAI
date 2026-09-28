"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ALERT_KIND_STYLE, AlertCard, type AlertKind, alertId, alertKind } from "@/components/AlertCard";
import { type Alert, api } from "@/lib/api";
import { useNotifications } from "@/lib/notifications-context";
import { usePolling } from "@/lib/usePolling";

type Filter = "all" | AlertKind;

// "anomaly" (yönü bilinmeyen anomali) pratikte oluşmuyor — filtrede artış/azalış yeterli.
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "increase", label: ALERT_KIND_STYLE.increase.label },
  { key: "decrease", label: ALERT_KIND_STYLE.decrease.label },
  { key: "critical", label: ALERT_KIND_STYLE.critical.label },
  { key: "warning", label: ALERT_KIND_STYLE.warning.label },
];

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
}

/** DOM id'si için güvenli biçim (bildirim kimliğinde ":" gibi karakterler var). */
function domId(id: string) {
  return `alert-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

const HIGHLIGHT_MS = 4000;

/** Bu haftanın tüm bildirimleri — zil listesinin tam hali (zil sadece son 10'u
 * saklıyor). Kartlar zil/toast ile aynı; türe göre filtre, güne göre gruplama,
 * tıklayınca Canlı Harita'da o bölge seçili açılır. `?focus=<bildirim kimliği>`
 * ile gelindiyse (zil/toast'tan) o bildirime kaydırılır ve kısa süre vurgulanır. */
function NotificationsContent({ focus }: { focus: string | null }) {
  const { data, error } = usePolling(api.alertHistory, 15000);
  const { unreadCount, markAllRead } = useNotifications();
  // Her yeni `focus` için bileşen yeniden kurulur (bkz. `key`) — filtre "Tümü"
  // ile başlar, yani odaklanılan bildirim her zaman listede görünür.
  const [filter, setFilter] = useState<Filter>("all");
  const [highlightExpired, setHighlightExpired] = useState(false);
  const scrolled = useRef(false);
  const highlighted = focus && !highlightExpired ? focus : null;

  // Odaklanılacak bildirim listede belirince ona kaydır — bir kez (15 sn'lik
  // yenilemelerde tekrar etmesin); vurgu kısa süre sonra kalkar.
  useEffect(() => {
    if (!focus || !data || scrolled.current) return;
    const el = document.getElementById(domId(focus));
    if (!el) return;
    scrolled.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Güvenlik ağı: yumuşak kaydırma bir sebeple olmadıysa (ör. sayfa geçişinin
    // kendi "en üste kaydır"ı araya girdiyse) kısa süre sonra doğrudan atla.
    const t = setTimeout(() => {
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight) el.scrollIntoView({ block: "center" });
    }, 700);
    return () => clearTimeout(t);
  }, [focus, data]);

  // Vurgu zamanlayıcısı veri yenilemelerinden bağımsız — sadece sayfa kapanınca iptal.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => setHighlightExpired(true), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [focus]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, increase: 0, decrease: 0, anomaly: 0, critical: 0, warning: 0 };
    for (const a of data ?? []) {
      c.all += 1;
      c[alertKind(a)] += 1;
    }
    return c;
  }, [data]);

  // Okunmamış olanlar zildeki sayaçla tutarlı: en yeni `unreadCount` bildirim.
  const unreadIds = useMemo(() => new Set((data ?? []).slice(0, unreadCount).map(alertId)), [data, unreadCount]);

  const groups = useMemo(() => {
    const filtered = (data ?? []).filter((a) => filter === "all" || alertKind(a) === filter);
    const byDay: { day: string; alerts: Alert[] }[] = [];
    for (const a of filtered) {
      const day = a.timestamp ? dayLabel(a.timestamp) : "Zaman bilinmiyor";
      const last = byDay.at(-1);
      if (last && last.day === day) last.alerts.push(a);
      else byDay.push({ day, alerts: [a] });
    }
    return byDay;
  }, [data, filter]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white">Bildirimler</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Bu haftanın tüm bildirimleri, en yeni üstte. Bir bildirime tıklayınca Canlı Harita&apos;da o bölge açılır.
          </p>
        </div>
        <button
          type="button"
          onClick={markAllRead}
          disabled={unreadCount === 0}
          className="text-sm text-blue-400 hover:text-blue-300 disabled:text-neutral-600 disabled:cursor-default"
        >
          Tümünü okundu işaretle{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => {
          const active = filter === key;
          const accent = key === "all" ? undefined : ALERT_KIND_STYLE[key].accent;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                active ? "border-white/40 bg-white/10 text-white" : "border-white/15 text-neutral-400 hover:text-white hover:bg-white/5"
              }`}
            >
              {accent && <span className="h-2 w-2 rounded-full" style={{ background: accent }} />}
              {label}
              <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums text-neutral-300">{counts[key]}</span>
            </button>
          );
        })}
      </div>

      {data && groups.length === 0 && (
        <div className="rounded-xl border border-white/15 bg-white/[0.05] p-8 text-center text-sm text-neutral-500">
          Bu türde bildirim yok.
        </div>
      )}

      {groups.map((g) => (
        <section key={g.day}>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">{g.day}</h2>
          <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0f1420] divide-y divide-white/5">
            {g.alerts.map((a) => {
              const id = alertId(a);
              return (
                <Link
                  key={id}
                  id={domId(id)}
                  href={`/live-map?zone=${a.zone_code}`}
                  className={`block scroll-mt-24 transition-colors hover:bg-white/[0.04] ${
                    highlighted === id ? "bg-blue-500/10 ring-2 ring-inset ring-blue-400/70" : ""
                  }`}
                >
                  <AlertCard alert={a} unread={unreadIds.has(id)} />
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function FocusedNotifications() {
  const focus = useSearchParams().get("focus");
  return <NotificationsContent key={focus ?? ""} focus={focus} />;
}

export default function NotificationsPage() {
  return (
    <Suspense fallback={null}>
      <FocusedNotifications />
    </Suspense>
  );
}
