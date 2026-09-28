"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setApiMallSlug, type MallInfo } from "@/lib/api";

const STORAGE_KEY = "mallflow_selected_mall";
const DEFAULT_MALL_SLUG = "mall-a";

function readStoredSlug(): string {
  if (typeof window === "undefined") return DEFAULT_MALL_SLUG;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_MALL_SLUG;
  } catch {
    return DEFAULT_MALL_SLUG;
  }
}

type MallContextValue = {
  mallSlug: string;
  malls: MallInfo[];
  setMallSlug: (slug: string) => void;
};

const MallContext = createContext<MallContextValue | null>(null);

export function MallProvider({ children }: { children: ReactNode }) {
  const [mallSlug, setMallSlugState] = useState<string>(() => {
    const initial = readStoredSlug();
    setApiMallSlug(initial);
    return initial;
  });
  const [malls, setMalls] = useState<MallInfo[]>([]);

  useEffect(() => {
    api.malls().then(setMalls).catch(() => setMalls([]));
  }, []);

  const setMallSlug = useCallback((slug: string) => {
    setApiMallSlug(slug);
    setMallSlugState(slug);
    try {
      window.localStorage.setItem(STORAGE_KEY, slug);
    } catch {
      // localStorage kullanılamıyorsa (gizli sekme vb.) sessizce yoksay
    }
  }, []);

  return <MallContext.Provider value={{ mallSlug, malls, setMallSlug }}>{children}</MallContext.Provider>;
}

export function useMall(): MallContextValue {
  const ctx = useContext(MallContext);
  if (!ctx) throw new Error("useMall() sadece MallProvider içinde kullanılabilir");
  return ctx;
}
