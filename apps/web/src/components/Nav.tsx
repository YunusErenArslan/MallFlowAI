"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  Box,
  Car,
  FileText,
  LayoutDashboard,
  LineChart,
  Map,
  Store,
  Target,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useMall } from "@/lib/mall-context";

const LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/live-map", label: "Canlı Harita", icon: Map },
  { href: "/predictions", label: "Kısa Vadeli Tahminler", icon: Activity },
  { href: "/trend", label: "Uzun Vadeli Tahminler", icon: LineChart },
  { href: "/parking", label: "Otopark", icon: Car },
  { href: "/parking-3d", label: "3D Görünüm", icon: Box },
  { href: "/stores", label: "Mağazalar", icon: Store },
  { href: "/reports", label: "Raporlar", icon: FileText },
  { href: "/notifications", label: "Bildirimler", icon: Bell },
  { href: "/anomalies", label: "Anomaliler", icon: AlertTriangle },
  { href: "/models", label: "Model Doğruluğu", icon: Target },
];

export default function Nav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { mallSlug, malls, setMallSlug } = useMall();

  return (
    <aside
      className={`shrink-0 border-r border-white/15 bg-[#0a0e1a]/80 backdrop-blur sticky top-0 h-screen flex flex-col overflow-y-auto overflow-x-hidden transition-[width] duration-200 ${
        collapsed ? "w-14" : "w-60"
      }`}
    >
      <div
        className={`flex items-center border-b border-white/15 py-5 ${collapsed ? "flex-col gap-2 px-2" : "justify-between px-5"}`}
      >
        {collapsed ? (
          <Image src="/logo-icon.png" alt="MallFlow AI" width={36} height={36} className="shrink-0 rounded-[10px]" />
        ) : (
          // Sadece marka: aktif sayfanın adı burada tekrar edilmiyor (sayfa başlığında ve menüde zaten var).
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <Image src="/logo-icon.png" alt="" width={36} height={36} className="shrink-0 rounded-[10px]" priority />
            <span className="whitespace-nowrap text-[17px] font-semibold tracking-tight text-white">
              MallFlow{" "}
              <span className="bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent">AI</span>
            </span>
          </Link>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Menüyü aç" : "Menüyü kapat"}
          className="shrink-0 text-neutral-500 hover:text-white transition-colors p-1.5 rounded-md hover:bg-white/5"
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {!collapsed && malls.length > 0 && (
        <div className="px-3 pt-3">
          <label className="block text-[10px] uppercase tracking-wide text-neutral-500 mb-1 px-0.5">AVM</label>
          <select
            value={mallSlug}
            onChange={(e) => setMallSlug(e.target.value)}
            className="w-full rounded-md border border-white/15 bg-white/5 text-sm text-white py-1.5 px-2 outline-none focus:border-blue-400/60 cursor-pointer"
          >
            {malls.map((mall) => (
              <option key={mall.slug} value={mall.slug} className="bg-[#0a0e1a] text-white">
                {mall.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <nav className="flex flex-col gap-0.5 p-3">
        {LINKS.map((link) => {
          const active = pathname === link.href;
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              title={collapsed ? link.label : undefined}
              className={`flex items-center gap-2.5 rounded-md text-sm whitespace-nowrap transition-colors py-2 ${
                collapsed ? "justify-center px-0" : "px-3"
              } ${active ? "bg-blue-500/15 text-white" : "text-neutral-400 hover:text-white hover:bg-white/5"}`}
            >
              <Icon size={17} strokeWidth={1.75} className="shrink-0" />
              {!collapsed && link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
