"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { useMall } from "./mall-context";

/** Seçili AVM'deki mağaza adları, bölge koduna göre — detay kartında
 * "bu bölgede hangi mağazalar var" için. Mağaza listesi statik olduğu için
 * AVM değişince bir kez çekilir. */
export function useStoresByZone(): Record<string, string[]> {
  const { mallSlug } = useMall();
  const [byZone, setByZone] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .storeSearch("")
      .then((stores) => {
        if (cancelled) return;
        const grouped: Record<string, string[]> = {};
        for (const s of stores) (grouped[s.zone_code] ??= []).push(s.name);
        setByZone(grouped);
      })
      .catch(() => {
        if (!cancelled) setByZone({});
      });
    return () => {
      cancelled = true;
    };
  }, [mallSlug]);
  return byZone;
}
