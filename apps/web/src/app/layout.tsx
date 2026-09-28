import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import AppShell from "@/components/AppShell";
import { MallProvider } from "@/lib/mall-context";
import { NotificationsProvider } from "@/lib/notifications-context";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MallFlow AI",
  description: "AVM içi ziyaretçi yoğunluğu analiz ve tahmin paneli",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="tr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-[#0a0e1a] text-neutral-100">
        <MallProvider>
          {/* Faz 8.5: `NotificationsProvider` bilinçli olarak `AppShell`'in
              (AVM değişince `key={mallSlug}` ile yeniden mount olan `<main>`)
              DIŞINDA — bildirim geçmişi (zil) AVM geçişlerinde kaybolmamalı,
              backend resetlenene kadar korunmalı. */}
          <NotificationsProvider>
            <Nav />
            <AppShell>{children}</AppShell>
          </NotificationsProvider>
        </MallProvider>
      </body>
    </html>
  );
}
