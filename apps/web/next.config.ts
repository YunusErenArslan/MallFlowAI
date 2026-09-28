import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Three.js/@react-three/fiber (otopark 3D görünümü), Strict Mode'un dev
  // modundaki kasıtlı çift-mount davranışıyla çakışıp WebGL context'ini
  // kaybediyordu ("Context Lost") — sayfa yenilemekle de düzelmiyordu.
  // Production build'de sorun yoktu (Strict Mode sadece dev'de aktif),
  // ama günlük geliştirme `next dev` ile yapılacağı için kapatıldı.
  reactStrictMode: false,
};

export default nextConfig;
