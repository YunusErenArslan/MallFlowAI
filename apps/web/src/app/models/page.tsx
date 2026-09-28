"use client";

import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

// Çok az örneklemde (ör. 6/6) yüzdeye çevirip renkli/büyük göstermek olduğundan
// çok daha "kesin" bir izlenim verir — bu eşiğin altında ham oranı nötr renkte
// gösteriyoruz, yüzde YOK.
const MIN_RELIABLE_ANOMALY_SAMPLES = 20;

function AccuracyRing({
  pct,
  rawLabel,
  thresholds = [85, 65],
}: {
  pct: number | null;
  rawLabel?: string;
  thresholds?: [number, number];
}) {
  if (rawLabel) {
    return <div className="text-4xl font-semibold text-neutral-400">{rawLabel}</div>;
  }
  if (pct == null) {
    return <div className="text-4xl font-semibold text-neutral-600">-</div>;
  }
  const color = pct >= thresholds[0] ? "text-emerald-400" : pct >= thresholds[1] ? "text-amber-400" : "text-red-400";
  return <div className={`text-5xl font-semibold ${color}`}>%{pct.toFixed(1)}</div>;
}

function ModelCard({
  title,
  type,
  description,
  pct,
  pctLabel = "canlı doğruluk",
  rawLabel,
  thresholds,
  detail,
  secondary,
}: {
  title: string;
  type: string;
  description: string;
  pct: number | null;
  pctLabel?: string;
  rawLabel?: string;
  thresholds?: [number, number];
  detail?: string;
  secondary?: string;
}) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.05] p-6 flex flex-col">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-200">{title}</h2>
        <span className="text-xs px-2 py-0.5 rounded-full border border-white/15 text-neutral-400">{type}</span>
      </div>
      <div className="mt-6">
        <AccuracyRing pct={pct} rawLabel={rawLabel} thresholds={thresholds} />
      </div>
      <div className="text-xs text-neutral-500 mt-1">{pctLabel}</div>
      {secondary && (
        <div className="mt-2 inline-flex w-fit items-center rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-neutral-400">
          {secondary}
        </div>
      )}
      <p className="mt-4 text-sm text-neutral-400 leading-relaxed">{description}</p>
      {detail && <p className="mt-2 text-xs text-neutral-600">{detail}</p>}
    </div>
  );
}

export default function ModelsPage() {
  const { data, error } = usePolling(api.modelsAccuracy, 15000);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Model Doğruluğu</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Projedeki 3 modelin CANLI doğruluğu — gerçek tahminler, gerçekleşen değerlerle karşılaştırılarak.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {data &&
        (() => {
          const a = data.anomaly.live;
          const knownAnomalies = a.known_anomalies;
          // Faz 8.29: sabit 20 eşiği, haftalık toplamı 20'nin altında olan
          // AVM'lerde (ör. Şehir Plaza, toplam 19) HİÇBİR ZAMAN aşılamıyordu
          // — AVM'nin kendi haftalık toplamına göre orantılı hale getirildi:
          // "20'ye ulaş" YA DA "bu haftanın TÜMÜ açığa çıktı" (hangisi daha
          // küçükse) yeterli sayılıyor.
          const reliabilityThreshold = Math.min(MIN_RELIABLE_ANOMALY_SAMPLES, a.total_week_anomalies);
          const reliableSample = knownAnomalies > 0 && knownAnomalies >= reliabilityThreshold;
          const f1Pct = reliableSample ? a.f1_pct : null;
          const rawRecallLabel =
            knownAnomalies > 0 && !reliableSample ? `${a.true_positives}/${knownAnomalies}` : undefined;

          return (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                <ModelCard
                  title="Kısa-vadeli Tahmin"
                  type="Gradient Boosting"
                  pct={data.short_term.level_accuracy_pct ?? null}
                  pctLabel="seviye doğruluğu"
                  secondary={
                    data.short_term.level_accuracy_pct != null
                      ? [
                          data.short_term.open_level_accuracy_pct != null &&
                            `AVM açıkken %${data.short_term.open_level_accuracy_pct.toFixed(0)}`,
                          data.short_term.pct_mae != null && `ortalama hata ±${data.short_term.pct_mae.toFixed(1)} puan`,
                          data.short_term.baseline_level_accuracy_pct != null &&
                            `basit tahmin %${data.short_term.baseline_level_accuracy_pct.toFixed(0)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : undefined
                  }
                  description="15/30/45/60 dakika sonrasının kişi sayısını tahmin eder. Her tahmin, hedef zamanı gelince gerçekleşen ölçümle karşılaştırılır. Büyük sayı: tahmin edilen doluluk seviyesinin (düşük / orta / yüksek / kritik) gerçekleşenle aynı çıkma oranı."
                  detail={["15", "30", "45", "60"]
                    .map((h) => `${h}dk %${data.short_term.live[h]?.level_accuracy_pct?.toFixed(0) ?? "-"}`)
                    .join(" · ")}
                />
                <ModelCard
                  title="Anomali Tespiti"
                  type="TFT (Derin Öğrenme)"
                  pct={f1Pct}
                  rawLabel={rawRecallLabel}
                  pctLabel={reliableSample || knownAnomalies === 0 ? "F1 (yakalama + doğru alarm dengesi)" : "henüz yeterli veri yok"}
                  secondary={
                    reliableSample
                      ? `yakalama %${a.recall_pct?.toFixed(1) ?? "-"} · doğru alarm %${a.precision_pct?.toFixed(1) ?? "-"} · ${a.false_positives} yanlış alarm`
                      : undefined
                  }
                  description="Her bölge için o saatte, o koşulda (hava, seans, giriş/çıkış akışı) beklenen doluluk bandını tahmin eder; gözlenen değer bandın dışına taşarsa anomali der. Buradaki yüzde F1: hem gerçek anomalileri yakalamayı hem de yanlış alarm vermemeyi birlikte ölçer."
                  detail={
                    knownAnomalies > 0
                      ? `${a.true_positives}/${knownAnomalies} gerçek anomali yakalandı${
                          reliableSample ? "" : ` — güvenilir sayılması için en az ${reliabilityThreshold} gerekiyor`
                        }`
                      : "henüz gerçek anomali birikmedi"
                  }
                />
                <ModelCard
                  title="Haftalık Trend"
                  type="LSTM (Derin Öğrenme)"
                  pct={data.trend.accuracy_pct}
                  description="Geçmiş 4 haftanın aynı saatlerine (t-7/14/21/28 gün) bakarak önümüzdeki haftayı tahmin eder. Her saatlik nokta, hedef zamanı geçince gerçekleşen değerle otomatik karşılaştırılır."
                  detail={
                    data.trend.live.sample_count > 0
                      ? `n=${data.trend.live.sample_count} hedef saati geçmiş tahmin`
                      : "henüz hedef saati geçmiş tahmin yok"
                  }
                />
              </div>

              <div className="rounded-lg border border-white/15 bg-white/[0.02] px-4 py-3 text-xs text-neutral-500">
                Kısa-vadeli tahmin için büyük sayı <strong>seviye doğruluğu</strong>: model, 15–60 dk sonrası için
                bölgenin düşük / orta / yüksek / kritik seviyesini (ekrandaki renkler) gerçekleşen ölçümle aynı bildi
                mi. &quot;Basit tahmin&quot; hiç model kullanmadan &quot;şimdiki kadar olur&quot; diyen karşılaştırma
                ölçütü — modelin katkısı ikisi arasındaki fark. Gece doluluk ~0 olduğundan tahmin kolay; bu yüzden AVM
                açıkken doğruluk ayrıca gösteriliyor. Trend için doğruluk =
                100 − ortalama hata (doluluk yüzde puanı). Anomali tespiti için
                büyük sayı <strong>F1</strong>: yakalama oranı (recall) ile doğru alarm oranının (precision)
                dengesi. Anomaliler okumaların yalnızca ~%0.5&apos;i olduğu için &quot;genel doğruluk&quot;
                yanıltıcıdır — hiç alarm vermeyen bir model bile %99.5 alır. Bilinen gerçek anomali sayısı{" "}
                {reliabilityThreshold}&apos;nin altındayken (bu AVM&apos;nin bu haftaki toplam anomali sayısı ile{" "}
                {MIN_RELIABLE_ANOMALY_SAMPLES} arasındaki küçük olan) yüzde yerine ham oran (ör. &quot;6/6&quot;) gri
                renkte gösterilir — az örneklemde yüzdeye çevirmek olduğundan kesin görünür.
              </div>
            </>
          );
        })()}
    </div>
  );
}
