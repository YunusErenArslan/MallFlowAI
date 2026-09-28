"use client";

import { useEffect, useState } from "react";

// WebSocket'in ilk bağlanışı (ve sayfa geçişleri) 1-2 sn sürebiliyor — bu süre
// içinde "Backend'e ulaşılamıyor" göstermek yanlış alarmdı. Hata ancak bu kadar
// süre boyunca hâlâ bağlanılamamışsa gösteriliyor.
const GRACE_MS = 4000;

/** Bağlantı `GRACE_MS` boyunca kurulamadıysa ve hiç veri yoksa `true`. */
export function useConnectionError(connected: boolean, hasData: boolean): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (connected || hasData) return;
    const id = setTimeout(() => setExpired(true), GRACE_MS);
    return () => {
      clearTimeout(id);
      setExpired(false);
    };
  }, [connected, hasData]);
  return expired && !connected && !hasData;
}
