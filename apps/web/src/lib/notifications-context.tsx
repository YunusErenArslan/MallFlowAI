"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { type Alert, type DashboardSummary } from "@/lib/api";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { useMall } from "@/lib/mall-context";

const EMPTY_ALERTS: Alert[] = [];

const TOAST_LIFETIME_MS = 4000;

export type NotificationItem = { id: string; alert: Alert; read?: boolean };

// `notificationsByMall[mallSlug]`/`toastsByMall[mallSlug]` tanımsızken bunu
// döndürüyoruz — `?? []` yazsaydık her render'da yeni bir dizi referansı
// oluşurdu.
const EMPTY_NOTIFICATIONS: NotificationItem[] = [];
const EMPTY_TOASTS: NotificationItem[] = [];

// Faz 8.43: zil listesi (`notificationsByMall`) artık sayfa yenilemede
// kaybolmasın diye localStorage'a yazılıyor — TOAST'lar (`toastsByMall`)
// bilinçli olarak KALICI DEĞİL (o anlık/geçici bir bildirim, yenilemede
// tekrar patlaması istenmiyor). `mall-context.tsx`'teki AYNI desen
// (guard + try/catch) kullanılıyor.
//
// Faz 8.44: LİSTE (dropdown'da gösterilen/saklanan
// satırlar) her zaman en fazla `MAX_STORED_PER_MALL` (10, zildeki
// `MAX_VISIBLE_BELL_ITEMS` ile AYNI — göstermediğimiz satırı saklamanın
// anlamı yok) kadar tutuluyor, AMA rozet üzerindeki SAYI bundan bağımsız,
// hiç sınırsız büyüyebilen ayrı bir sayaç (`totalCountByMall`) — "toplam
// kaç bildirim geldi" ile "en son kaçı gösteriliyor" iki farklı şey.
const NOTIFICATIONS_STORAGE_KEY = "mallflow_notifications_v1";
const COUNTS_STORAGE_KEY = "mallflow_notification_counts_v1";
// Okunmamış bildirim sayısı (rozet) — "Tümünü okundu işaretle" ile sıfırlanır.
// Toplam sayaçtan (`COUNTS_STORAGE_KEY`, "+N bildirim daha" için) ayrı tutuluyor.
const UNREAD_STORAGE_KEY = "mallflow_notification_unread_v1";
const MAX_STORED_PER_MALL = 10;

function readStoredNotifications(): Record<string, NotificationItem[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredNotifications(data: Record<string, NotificationItem[]>) {
  try {
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage kullanılamıyorsa (gizli sekme, kota dolu vb.) sessizce yoksay
  }
}

// Faz 8.46: backend her yeniden başladığında (her reset — yeni rastgele
// hafta) `boot_id` değişir. Tarayıcıda son GÖRÜLEN `boot_id` saklanıyor;
// WebSocket mesajlarındaki `boot_id` bundan farklıysa (ya da hiç yoksa) zil
// listesi/rozet ESKİ bir haftaya ait demektir, temizleniyor. Kontrol eskiden
// sadece sayfa açılışında (`/health` ile) yapılıyordu — sayfa açıkken backend
// resetlenirse eski bildirimler yenilemeye kadar kalıyordu; artık HER mesajda.
const BOOT_ID_STORAGE_KEY = "mallflow_boot_id";

// Her AVM için istemcinin gördüğü SON tick'in zaman damgası — WebSocket
// yeniden bağlanınca (ya da sayfa yenilenince) backend'in gönderdiği son 24
// saatlik anomali alarmlarından SADECE bundan sonrakiler "kaçırılmış" sayılıp
// zile ekleniyor. Anomaliler tek tick sürdüğü için canlı yayında bir daha
// görünmezler; bu olmadan kopukluk sırasında gelenler tamamen kayboluyordu.
const LAST_TICK_STORAGE_KEY = "mallflow_last_tick_v1";

function readStoredLastTicks(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LAST_TICK_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredLastTicks(data: Record<string, string>) {
  try {
    window.localStorage.setItem(LAST_TICK_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage kullanılamıyorsa (gizli sekme, kota dolu vb.) sessizce yoksay
  }
}

function latestTick(data: DashboardSummary): string | null {
  let latest: string | null = null;
  for (const z of data.zones) {
    if (z.timestamp && (latest === null || z.timestamp > latest)) latest = z.timestamp;
  }
  return latest;
}

function readStoredBootId(): string | null {
  try {
    return window.localStorage.getItem(BOOT_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredBootId(bootId: string) {
  try {
    window.localStorage.setItem(BOOT_ID_STORAGE_KEY, bootId);
  } catch {
    // localStorage kullanılamıyorsa (gizli sekme, kota dolu vb.) sessizce yoksay
  }
}

function readStoredCounts(key = COUNTS_STORAGE_KEY): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredCounts(data: Record<string, number>, key = COUNTS_STORAGE_KEY) {
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // localStorage kullanılamıyorsa (gizli sekme, kota dolu vb.) sessizce yoksay
  }
}

function alertKey(a: Alert) {
  return `${a.zone_code}-${a.severity}`;
}

/** Bildirimlerin TEK doğruluk kaynağı — hem zildeki KALICI listeyi hem sağ
 * üstteki GEÇİCİ toast'ları besler. `reportUpdate(mallSlug, data)` her
 * AVM'nin KENDİ `MallWatcher`'ından (aşağıda) her yeni WebSocket mesajında
 * çağrılan İMPERATİF bir fonksiyon:
 *
 * - `notificationsByMall` (zil) ve `toastsByMall` (toast) — İKİSİ DE AVM
 *   BAŞINA ayrı tutuluyor: arka plandaki HER AVM için birikmeye devam eder
 *   (izleme hiç durmaz), ama `NotificationsProvider` sadece O AN SEÇİLİ
 *   AVM'nin dizisini dışarı veriyor — AVM seçilince zil ve toast'larda
 *   sadece o AVM'nin bildirimleri görünür. Bir uyarı İLK ORTAYA ÇIKTIĞINDA (o AVM için bilinen önceki
 *   durumda yokken şimdi varsa) her iki diziye de EKLENİR; zil listesinden
 *   toast 4sn sonra kendiliğinden kaybolsa da, X ile kapatılsa da SİLİNMEZ —
 *   "Tümünü okundu işaretle" O AN bakılan AVM'nin bildirimlerini silmeden
 *   okundu yapar ve rozetini sıfırlar.
 *
 * "Yenilik" karşılaştırması AVM BAŞINA ayrı bir önceki-durum kaydı
 * (`prevAlertsByMallRef`) kullanıyor — aksi halde AVM'ler arası geçişte, bir
 * AVM'nin zaten bilinen uyarıları başka bir AVM'nin durumuyla karşılaştırılıp
 * yanlışlıkla "yeni" sayılırdı. */
function useAlertNotifications() {
  // Faz 8.43: boş state ile başlıyoruz (SUNUCU render'ıyla AYNI) — lazy
  // initializer'da doğrudan `readStoredNotifications()` çağırmak (mall-
  // context.tsx'teki mallSlug deseninin aksine) burada GÖRÜNÜR bir hydration
  // uyuşmazlığına yol açıyordu (zil rozeti sunucuda yok, istemcide var).
  // Bunun yerine mount'ta bir useEffect ile (SADECE client'ta çalışır)
  // hydrate ediyoruz.
  const [notificationsByMall, setNotificationsByMall] = useState<Record<string, NotificationItem[]>>({});
  const [totalCountByMall, setTotalCountByMall] = useState<Record<string, number>>({});
  const [unreadCountByMall, setUnreadCountByMall] = useState<Record<string, number>>({});
  const [toastsByMall, setToastsByMall] = useState<Record<string, NotificationItem[]>>({});
  const prevAlertsByMallRef = useRef<Record<string, Alert[]>>({});
  const scheduledRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef(false);
  const bootIdRef = useRef<string | null>(null);
  const lastTickByMallRef = useRef<Record<string, string>>({});

  // Mount'ta BİR KEZ dış (localStorage) veriyle senkronize ediyoruz; SSR
  // çıktısıyla (boş state) hydration uyuşmazlığı yaşamamanın bilinen yolu bu.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotificationsByMall(readStoredNotifications());
    setTotalCountByMall(readStoredCounts());
    setUnreadCountByMall(readStoredCounts(UNREAD_STORAGE_KEY));
    hydratedRef.current = true;

    bootIdRef.current = readStoredBootId();
    lastTickByMallRef.current = readStoredLastTicks();
  }, []);

  // Zil listesi/toplam sayaç değişince localStorage'a yaz — ama hydration'dan
  // ÖNCE (henüz okunmuş veri state'e işlenmeden) tetiklenirse boş `{}` yazıp
  // önceki kayıtlı veriyi silmesin diye `hydratedRef` ile korunuyor.
  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStoredNotifications(notificationsByMall);
  }, [notificationsByMall]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStoredCounts(totalCountByMall);
  }, [totalCountByMall]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStoredCounts(unreadCountByMall, UNREAD_STORAGE_KEY);
  }, [unreadCountByMall]);

  const reportUpdate = useCallback((mallSlug: string, data: DashboardSummary) => {
    // Backend resetlendiyse (yeni hafta) önceki haftanın TÜM AVM'lere ait zil
    // listesi, rozeti, toast'ları ve "son görülen tick" kayıtları temizlenir.
    // Aynı çağrıda aşağıda eklenen yeni bildirimler, fonksiyonel state
    // güncellemeleri sırayla işlendiği için temizlikten SONRA uygulanır.
    if (data.boot_id && data.boot_id !== bootIdRef.current) {
      bootIdRef.current = data.boot_id;
      writeStoredBootId(data.boot_id);
      prevAlertsByMallRef.current = {};
      lastTickByMallRef.current = {};
      writeStoredLastTicks({});
      setNotificationsByMall({});
      setTotalCountByMall({});
      setUnreadCountByMall({});
      setToastsByMall({});
    }

    // Kaçırılan anomali alarmları: sadece bu AVM için daha önce bir tick
    // görmüşsek (aynı backend oturumunda) ve alarm ondan SONRAYSA. Toast
    // açılmaz (eski olay, "şimdi oldu" izlenimi vermesin) — sadece zile ve
    // rozete eklenir.
    const lastSeen = lastTickByMallRef.current[mallSlug];
    const missed =
      lastSeen && data.recent_anomaly_alerts
        ? data.recent_anomaly_alerts.filter((a) => a.timestamp && a.timestamp > lastSeen)
        : [];
    const tick = latestTick(data);
    if (tick && tick !== lastSeen) {
      lastTickByMallRef.current = { ...lastTickByMallRef.current, [mallSlug]: tick };
      writeStoredLastTicks(lastTickByMallRef.current);
    }

    const alerts = data.alerts;
    const prevForThisMall = prevAlertsByMallRef.current[mallSlug] ?? EMPTY_ALERTS;
    const alertsChanged = alerts !== prevForThisMall;
    prevAlertsByMallRef.current = { ...prevAlertsByMallRef.current, [mallSlug]: alerts };

    const prevKeys = new Set(prevForThisMall.map(alertKey));
    const newOnes = alertsChanged ? alerts.filter((a) => !prevKeys.has(alertKey(a))) : [];
    const toItem = (a: Alert) => ({ id: `${mallSlug}-${alertKey(a)}-${a.timestamp ?? "no-ts"}`, alert: a });
    const liveItems = newOnes.map(toItem);
    const liveIds = new Set(liveItems.map((it) => it.id));
    const missedItems = missed.map(toItem).filter((it) => !liveIds.has(it.id));
    if (liveItems.length === 0 && missedItems.length === 0) return;

    // Zil listesi en yeni üstte olacak şekilde zaman sırasına göre
    const items = [...liveItems, ...missedItems].sort((x, y) =>
      (y.alert.timestamp ?? "").localeCompare(x.alert.timestamp ?? ""),
    );
    // Güvenlik ağı: id'ye göre tekilleştir — birden fazla `MallWatcher`
    // örtüşen içerikle çağırsa bile React'in "aynı key" hatasını engeller.
    setNotificationsByMall((prev) => {
      const existingIds = new Set((prev[mallSlug] ?? []).map((n) => n.id));
      const deduped = items.filter((it) => !existingIds.has(it.id));
      if (deduped.length === 0) return prev;
      // `MAX_STORED_PER_MALL`: sadece SON N tanesi saklanıyor/gösteriliyor —
      // rozet sayısı (`totalCountByMall`) buna bağlı değil, ayrı büyüyor.
      return {
        ...prev,
        [mallSlug]: [...deduped, ...(prev[mallSlug] ?? [])].slice(0, MAX_STORED_PER_MALL),
      };
    });
    // `items` zaten `prevAlertsByMallRef`'e göre (fonksiyonun başında,
    // senkron) hesaplanmış "yeni" uyarılar — rozet sayacı bunun üzerinden
    // artıyor, ayrı bir dedup'a gerek yok (üstteki `existingIds` kontrolü
    // sadece aynı tick'te birden fazla `MallWatcher` çağrısına karşı bir
    // güvenlik ağı, normal akışta `items` zaten tekil).
    setTotalCountByMall((prev) => ({ ...prev, [mallSlug]: (prev[mallSlug] ?? 0) + items.length }));
    setUnreadCountByMall((prev) => ({ ...prev, [mallSlug]: (prev[mallSlug] ?? 0) + items.length }));
    if (liveItems.length === 0) return;
    setToastsByMall((prev) => {
      const existingIds = new Set((prev[mallSlug] ?? []).map((t) => t.id));
      const deduped = liveItems.filter((it) => !existingIds.has(it.id));
      if (deduped.length === 0) return prev;
      return { ...prev, [mallSlug]: [...(prev[mallSlug] ?? []), ...deduped] };
    });
  }, []);

  // Toast'ların otomatik kayboluşu: her toast KENDİ zamanlayıcısını, kendisi
  // için daha önce zamanlayıcı kurulmadıysa alır (`scheduledRef` ile
  // tekilleştirilir) — hangi AVM'ye ait olursa olsun, seçili olsun olmasın.
  useEffect(() => {
    Object.entries(toastsByMall).forEach(([mallSlug, toasts]) => {
      toasts.forEach((t) => {
        if (scheduledRef.current.has(t.id)) return;
        scheduledRef.current.add(t.id);
        setTimeout(() => {
          setToastsByMall((prev) => ({
            ...prev,
            [mallSlug]: (prev[mallSlug] ?? []).filter((x) => x.id !== t.id),
          }));
        }, TOAST_LIFETIME_MS);
      });
    });
  }, [toastsByMall]);

  // Bildirimler silinmez, okundu işaretlenir — geçmiş zilde kalır, rozet sıfırlanır.
  const markAllRead = useCallback((mallSlug: string) => {
    setNotificationsByMall((prev) => ({
      ...prev,
      [mallSlug]: (prev[mallSlug] ?? []).map((n) => (n.read ? n : { ...n, read: true })),
    }));
    setUnreadCountByMall((prev) => ({ ...prev, [mallSlug]: 0 }));
  }, []);

  const dismissToast = useCallback((mallSlug: string, id: string) => {
    setToastsByMall((prev) => ({ ...prev, [mallSlug]: (prev[mallSlug] ?? []).filter((t) => t.id !== id) }));
  }, []);

  return { notificationsByMall, totalCountByMall, unreadCountByMall, toastsByMall, reportUpdate, markAllRead, dismissToast };
}

/** Her AVM için KENDİ, sürekli açık WebSocket bağlantısını kurup canlı
 * tutan görünmez bileşen — `key={mallSlug}` ile bir kere mount olur ve o
 * AVM SEÇİLİ olsun olmasın (arka planda da) hiç kapanmadan çalışmaya devam
 * eder. Böylece "seçili olmayan AVM'de farklı/daha seyrek bir mekanizma"
 * yok — hepsi BİREBİR aynı: gerçek zamanlı WebSocket, her tick'te anında.
 * Sadece o an SEÇİLİ olan AVM'ninki, tam `data`/`connected`'ı yukarı
 * (Dashboard'un stat kartları, Canlı Harita, 3D Görünüm için) da bildiriyor. */
function MallWatcher({
  mallSlug,
  isActive,
  reportUpdate,
  onActiveUpdate,
}: {
  mallSlug: string;
  isActive: boolean;
  reportUpdate: (mallSlug: string, data: DashboardSummary) => void;
  onActiveUpdate: (data: DashboardSummary | null, connected: boolean) => void;
}) {
  const { data, connected } = useLiveSocket<DashboardSummary>(`/malls/${mallSlug}/ws/live`);

  useEffect(() => {
    if (data) reportUpdate(mallSlug, data);
  }, [data, mallSlug, reportUpdate]);

  useEffect(() => {
    if (isActive) onActiveUpdate(data, connected);
  }, [isActive, data, connected, onActiveUpdate]);

  return null;
}

type NotificationsContextValue = {
  data: DashboardSummary | null;
  connected: boolean;
  notifications: NotificationItem[];
  /** Zil rozetinde gösterilecek TOPLAM sayı — `notifications.length`'ten
   * FARKLI: liste en fazla son `MAX_STORED_PER_MALL` (10) satırı tutuyor,
   * ama bu sayı hiç sınırsız büyüyebiliyor (bkz. Faz 8.44). */
  totalCount: number;
  /** Rozette gösterilen okunmamış bildirim sayısı. */
  unreadCount: number;
  toasts: NotificationItem[];
  markAllRead: () => void;
  dismissToast: (id: string) => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** `layout.tsx`'te `AppShell`'in (AVM değişince `key={mallSlug}` ile
 * yeniden mount olan `<main>`) DIŞINA yerleştiriliyor — bu yüzden AVM
 * değiştirmek bu bileşeni hiç yeniden mount ETMİYOR, dolayısıyla bildirim
 * state'i AVM geçişlerinde KORUNUYOR.
 *
 * Tasarım kararı: sadece o an ekranda izlenen AVM DEĞİL, DİĞER (arka
 * plandaki) AVM'ler de — VE BİREBİR AYNI MEKANİZMAYLA (gerçek zamanlı
 * WebSocket, REST yoklaması değil) — sürekli izlenmeli. Bu yüzden `malls`
 * listesindeki HER AVM için kendi `MallWatcher`'ı render ediliyor, hepsi
 * aynı anda, aynı şekilde canlı bağlı kalıyor; AVM değiştirmek sadece
 * "hangisi `isActive`" bayrağını değiştiriyor, hiçbir bağlantıyı KOPARMIYOR
 * — bu yüzden AVM değiştirince Dashboard'daki veri de ANINDA (yeniden
 * bağlanma beklemeden) güncelleniyor, çünkü o AVM zaten arka planda
 * bağlıydı. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { mallSlug, malls } = useMall();
  const { notificationsByMall, totalCountByMall, unreadCountByMall, toastsByMall, reportUpdate, markAllRead, dismissToast } =
    useAlertNotifications();
  const [activeData, setActiveData] = useState<DashboardSummary | null>(null);
  const [activeConnected, setActiveConnected] = useState(false);

  const onActiveUpdate = useCallback((data: DashboardSummary | null, connected: boolean) => {
    setActiveData(data);
    setActiveConnected(connected);
  }, []);

  const value: NotificationsContextValue = {
    data: activeData,
    connected: activeConnected,
    notifications: notificationsByMall[mallSlug] ?? EMPTY_NOTIFICATIONS,
    totalCount: totalCountByMall[mallSlug] ?? 0,
    unreadCount: unreadCountByMall[mallSlug] ?? 0,
    toasts: toastsByMall[mallSlug] ?? EMPTY_TOASTS,
    markAllRead: () => markAllRead(mallSlug),
    dismissToast: (id: string) => dismissToast(mallSlug, id),
  };

  return (
    <NotificationsContext.Provider value={value}>
      {malls.map((m) => (
        <MallWatcher
          key={m.slug}
          mallSlug={m.slug}
          isActive={m.slug === mallSlug}
          reportUpdate={reportUpdate}
          onActiveUpdate={onActiveUpdate}
        />
      ))}
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications() sadece NotificationsProvider içinde kullanılabilir");
  return ctx;
}
