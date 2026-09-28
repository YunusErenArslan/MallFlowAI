"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");

/** Backend'in /ws/live endpoint'ine bağlanır, her "occupancy_update" mesajını state'e yazar.
 * Bağlantı koparsa (backend yeniden başlarken vb.) birkaç saniye sonra otomatik yeniden dener. */
export function useLiveSocket<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      socket = new WebSocket(`${WS_BASE}${path}`);

      socket.onopen = () => {
        if (cancelled) return;
        retryRef.current = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        if (cancelled) return;
        try {
          setData(JSON.parse(event.data));
        } catch {
          // yoksay
        }
      };
      socket.onclose = () => {
        // NOT: `path` değişince (ör. AVM değiştirilince) bu effect'in
        // cleanup'ı ESKİ soketi kasıtlı olarak kapatıyor (`cancelled=true`
        // set edip `socket.close()` çağırıyor) — ama tarayıcının `close`
        // olayı ASENKRON geliyor, bazen YENİ soket zaten açılıp veri almışken
        // gelir. `cancelled` kontrolünü EN BAŞA almazsak, bu gecikmiş "eski"
        // onclose `setConnected(false)` çağırıp az önce açılmış YENİ
        // bağlantıyı yanlışlıkla "koptu" gibi gösterirdi (anlık "Backend'e
        // ulaşılamıyor" flaşının kök nedeni buydu).
        if (cancelled) return;
        setConnected(false);
        const delay = Math.min(5000, 500 * 2 ** retryRef.current);
        retryRef.current += 1;
        retryTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [path]);

  return { data, connected };
}
