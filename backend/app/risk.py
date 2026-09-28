"""Risk seviyesi sınıflandırması ve kural tabanlı (LLM'siz) açıklama üretimi."""

LEVEL_WORDS = {
    "dusuk": "düşük",
    "orta": "orta",
    "yuksek": "yüksek",
    "cok_yuksek": "çok yüksek",
}


def occupancy_level(pct: float) -> str:
    if pct < 40:
        return "dusuk"
    if pct < 65:
        return "orta"
    if pct < 85:
        return "yuksek"
    return "cok_yuksek"


def risk_level(current_pct: float, predicted_pct: float) -> str:
    trend = predicted_pct - current_pct
    if predicted_pct >= 90 or (predicted_pct >= 80 and trend >= 15):
        return "critical"
    if predicted_pct >= 80:
        return "high"
    if predicted_pct >= 60:
        return "medium"
    return "low"


def build_explanation(
    *,
    zone_name: str,
    zone_type: str,
    horizon_minutes: int,
    predicted_pct: float,
    hour: int,
    is_weekend: bool,
    weather_condition: str,
    has_event: bool,
) -> str:
    reasons: list[str] = []
    if zone_type == "food_court" and 18 <= hour <= 21:
        reasons.append("akşam yemek saati")
    if zone_type == "food_court" and 12 <= hour <= 13:
        reasons.append("öğle yemek saati")
    if has_event and zone_type == "cinema":
        reasons.append("sinema seanslarının başlangıç saatleri")
    if is_weekend:
        reasons.append("hafta sonu yoğunluğu")
    if weather_condition == "yagmurlu":
        reasons.append("yağmurlu hava nedeniyle kapalı alan tercihi")
    if not reasons:
        reasons.append("genel ziyaretçi yoğunluğu")

    if len(reasons) == 1:
        reason_text = reasons[0]
    else:
        reason_text = ", ".join(reasons[:-1]) + " ve " + reasons[-1]

    level_word = LEVEL_WORDS[occupancy_level(predicted_pct)]

    return (
        f"{zone_name} bölgesinde önümüzdeki {horizon_minutes} dakika içerisinde {level_word} yoğunluk "
        f"beklenmektedir (%{predicted_pct:.0f}). Yoğunluğun temel nedeni {reason_text} olarak "
        f"değerlendirilmektedir."
    )


RECOMMENDATION_RULES = [
    ("food_court", "critical", "Ziyaretçileri tabela ve anonslarla alternatif yemek alanlarına yönlendir."),
    ("food_court", "critical", "Temizlik personelini bölgeye yönlendir."),
    ("cinema", "critical", "Gişe/giriş için ek yönlendirme personeli görevlendir."),
    ("*", "critical", "Güvenlik personelini yoğun bölgeye yönlendir."),
    ("*", "high", "Bölge girişinde yönlendirme yap; ziyaretçileri daha sakin alanlara yönlendir."),
]


def build_recommendations(zone_type: str, risk: str) -> list[str]:
    if risk not in ("high", "critical"):
        return []
    return [msg for (zt, r, msg) in RECOMMENDATION_RULES if r == risk and zt in (zone_type, "*")]
