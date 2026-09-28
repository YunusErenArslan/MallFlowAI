"use client";

import type { ReactNode } from "react";
import { useMall } from "@/lib/mall-context";

/** `key={mallSlug}` — AVM değiştiğinde tüm sayfa alt ağacını KASITLI olarak
 * yeniden mount ediyoruz: sayfaların `useEffect(() => { api.foo()... }, [])`
 * gibi tek seferlik veri çekme/WebSocket bağlama mantığını tek tek AVM'ye
 * duyarlı hale getirmek yerine, React'in kendi remount mekanizmasıyla hepsi
 * otomatik olarak yeni AVM için sıfırdan çalışıyor. */
export default function AppShell({ children }: { children: ReactNode }) {
  const { mallSlug } = useMall();
  return (
    <main key={mallSlug} className="flex-1 min-w-0 mx-auto w-full max-w-6xl px-6 py-8">
      {children}
    </main>
  );
}
