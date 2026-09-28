"use client";

import { useEffect, useRef, useState } from "react";

/** WebSocket akışına bağlı REST isteği: `liveKey` (ör. son tick'in zamanı)
 * her değiştiğinde veriyi yeniden çeker, ama en fazla `minIntervalMs`'de bir —
 * ağır uç noktaları (haftalık rapor) her saniyelik tick'te hesaplatmamak için.
 * Aralık içinde gelen tick'ler kaybolmaz: aralık dolunca son hali çekilir.
 * Simülasyon durunca tick gelmez, veri de son haliyle kalır. */
export function useLiveFetch<T>(fetcher: () => Promise<T>, liveKey: string | undefined, minIntervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    async function run() {
      lastFetch.current = Date.now();
      try {
        const result = await fetcher();
        if (mounted.current) {
          setData(result);
          setError(null);
        }
      } catch {
        if (mounted.current) setError("Backend'e ulaşılamıyor (http://localhost:8000 çalışıyor mu?)");
      }
    }

    const wait = Math.max(0, lastFetch.current + minIntervalMs - Date.now());
    const id = setTimeout(run, wait);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, minIntervalMs]);

  return { data, error };
}
