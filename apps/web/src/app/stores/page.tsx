"use client";

import { useEffect, useState } from "react";
import { api, type StoreResult } from "@/lib/api";
import { LEVEL_BADGE_CLASS, LEVEL_LABEL } from "@/lib/level";

type ZoneGroup = {
  zone_code: string;
  zone_name: string;
  floor_name: string;
  occupancy_pct: number | null;
  level: StoreResult["level"];
  stores: StoreResult[];
};

/** Doluluk MAĞAZA değil BÖLGE bazında ölçülüyor — aynı bölgedeki mağazalar
 * tek bir başlık altında toplanıyor, yüzde başlıkta bir kez gösteriliyor
 * (her mağaza satırında tekrarlamak "Apple Store %45 dolu" gibi yanlış
 * okunuyordu). Backend sonuçları zaten en az yoğun bölgeden başlayarak
 * sıralıyor; grupların sırası bu sırayı koruyor. */
function groupByZone(results: StoreResult[]): ZoneGroup[] {
  const groups = new Map<string, ZoneGroup>();
  for (const store of results) {
    const group = groups.get(store.zone_code);
    if (group) {
      group.stores.push(store);
    } else {
      groups.set(store.zone_code, {
        zone_code: store.zone_code,
        zone_name: store.zone_name,
        floor_name: store.floor_name,
        occupancy_pct: store.occupancy_pct,
        level: store.level,
        stores: [store],
      });
    }
  }
  return [...groups.values()];
}

export default function StoresPage() {
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [results, setResults] = useState<StoreResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.storeCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      api
        .storeSearch(query)
        .then((r) => {
          setResults(r);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    }, 200);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Mağazalar</h1>
        <p className="text-sm text-neutral-500 mt-1">
          İsim veya kategoriyle ara — mağazalar bulundukları bölgeye göre gruplanır, en az yoğun bölgeden başlar.
          Doluluk bölge bazında ölçülür (mağaza bazında değil).
        </p>
      </div>

      <div className="space-y-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Örn. Kahve, Starbucks, Moda..."
          className="w-full rounded-lg border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-blue-500/50"
        />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setQuery(cat)}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  query === cat
                    ? "border-blue-500/50 bg-blue-500/15 text-white"
                    : "border-white/15 text-neutral-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {results && results.length === 0 && (
        <div className="rounded-xl border border-white/15 bg-white/[0.05] px-5 py-6 text-sm text-neutral-500 text-center">
          Sonuç bulunamadı.
        </div>
      )}

      {results && results.length > 0 && (
        <div className="space-y-4">
          {groupByZone(results).map((group) => (
            <div key={group.zone_code} className="rounded-xl border border-white/15 bg-white/[0.05]">
              <div className="flex items-center gap-4 px-5 py-3 border-b border-white/10">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">{group.zone_name}</div>
                  <div className="text-xs text-neutral-500">{group.floor_name}</div>
                </div>
                {group.occupancy_pct != null && (
                  <span className="text-sm text-neutral-300 shrink-0" title="Bölgenin anlık doluluğu">
                    Bölge doluluğu %{group.occupancy_pct.toFixed(0)}
                  </span>
                )}
                {group.level && (
                  <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border ${LEVEL_BADGE_CLASS[group.level]}`}>
                    {LEVEL_LABEL[group.level]}
                  </span>
                )}
              </div>
              <div className="divide-y divide-white/5">
                {group.stores.map((store) => (
                  <div key={store.store_id} className="flex items-center gap-4 px-5 py-2.5">
                    <div className="flex-1 min-w-0 text-sm text-neutral-100">{store.name}</div>
                    <div className="shrink-0 text-xs text-neutral-500">{store.category}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
