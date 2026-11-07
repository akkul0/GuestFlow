"""
Sesli cevap servisi (metinden sese) — Chatterbox Multilingual, MIT lisanslı.

OpenAI'nin /v1/audio/speech biçimini taklit eder; ses asistanı bu adrese
metni gönderir, 24 kHz 16-bit mono ham ses (PCM) geri alır.

Dil, metnin kendisinden bulunur (Türkçe, İngilizce, Almanca, Rusça);
istekte "language" alanı varsa o kullanılır.

İsteğe bağlı sesler: /sesler/tr.wav, en.wav, de.wav, ru.wav
(o dilde konuşan 10-20 sn temiz kayıt). Yoksa modelin varsayılan sesi.
"""
import logging
import re
import os
import threading
import time

import numpy as np
import torch
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse
from lingua import Language, LanguageDetectorBuilder

import torchaudio
from silero_vad import get_speech_timestamps, load_silero_vad

import torch.nn.functional as F
from chatterbox.models.s3tokenizer import drop_invalid_tokens
from chatterbox.models.t3.modules.cond_enc import T3Cond
from chatterbox.mtl_tts import ChatterboxMultilingualTTS, punc_norm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

DILLER = {
    Language.TURKISH: "tr",
    Language.ENGLISH: "en",
    Language.GERMAN: "de",
    Language.RUSSIAN: "ru",
}
VARSAYILAN_DIL = os.getenv("TTS_VARSAYILAN_DIL", "tr")
SES_KLASORU = os.getenv("TTS_SES_KLASORU", "/sesler")
# Ses ayarları (deneme için .env'den değiştirilebilir)
SICAKLIK = float(os.getenv("TTS_SICAKLIK", "0.6"))   # düşük = daha düzgün, daha az "yapay" ses
ABARTI = float(os.getenv("TTS_ABARTI", "0.4"))       # duygu/vurgu miktarı
CFG = float(os.getenv("TTS_CFG", "0.5"))             # metne bağlılık
TEMIZLE = os.getenv("TTS_TEMIZLE", "1") != "0"        # konuşma dışı sesleri (hırıltı, gurultu) at

algilayici = LanguageDetectorBuilder.from_languages(*DILLER).build()

cihaz = "cuda" if torch.cuda.is_available() else "cpu"
log.info("Model yükleniyor (%s)… ilk açılışta ~3 GB iner", cihaz)
model = ChatterboxMultilingualTTS.from_pretrained(device=cihaz)
varsayilan_ses = model.conds

# Dile özel sesler (varsa)
sesler: dict[str, object] = {}
for dil in DILLER.values():
    yol = os.path.join(SES_KLASORU, f"{dil}.wav")
    if os.path.exists(yol):
        model.prepare_conditionals(yol, exaggeration=ABARTI)
        sesler[dil] = model.conds
        log.info("Ses yüklendi: %s", yol)
model.conds = varsayilan_ses

vad = load_silero_vad()


def temizle(wav: np.ndarray, sr: int) -> np.ndarray:
    """Model bazen kelime/cümle aralarında konuşma olmayan sesler üretiyor
    (hırıltı, guruldama). Konuşma algılayıcıyla (Silero VAD) yalnızca konuşma
    kısımları tutulur; aralardaki 0,35 sn'den uzun boşluklar 0,2 sn sessizliğe
    çevrilir, sondaki fazlalık kesilir. Konuşmanın kendisine dokunulmaz."""
    t16 = torchaudio.functional.resample(torch.from_numpy(wav.astype(np.float32)), sr, 16000)
    parcalar = get_speech_timestamps(t16, vad, sampling_rate=16000, threshold=0.5,
                                     min_speech_duration_ms=120, min_silence_duration_ms=120, speech_pad_ms=40)
    if not parcalar:
        return wav
    k = sr / 16000
    sinirlar = [(int(p["start"] * k), int(p["end"] * k)) for p in parcalar]
    cikti = []
    for i, (b, e) in enumerate(sinirlar):
        if i == 0:
            b = max(0, b - int(0.04 * sr))
        cikti.append(wav[b:e])
        if i + 1 < len(sinirlar):
            sonraki = sinirlar[i + 1][0]
            if (sonraki - e) / sr > 0.35:
                cikti.append(np.zeros(int(0.2 * sr), dtype=wav.dtype))
            else:
                cikti.append(wav[e:sonraki])
        else:
            kuyruk = wav[e:min(len(wav), e + int(0.12 * sr))]
            cikti.append(kuyruk * np.linspace(1, 0, len(kuyruk), dtype=wav.dtype))
    return np.concatenate(cikti)


kilit = threading.Lock()  # tek ekran kartı: istekler sırayla


# Türkçe okurken yabancı kelimeler yazıldığı gibi okunmasın
SOYLENIS = {
    "tr": [
        (re.compile(r"StayLine", re.I), "Steylayn"),
        (re.compile(r"\bWi-?Fi\b", re.I), "vay fay"),
        (re.compile(r"WhatsApp", re.I), "Vatsap"),
        (re.compile(r"\bà la carte\b|\ba la carte\b", re.I), "alakart"),
        (re.compile(r"\bcheck-?in\b", re.I), "çekin"),
        (re.compile(r"\bcheck-?out\b", re.I), "çekaut"),
        (re.compile(r"\bLobby\b", re.I), "Lobi"),
    ],
}


def soyle(metin: str, dil: str) -> str:
    for desen, yerine in SOYLENIS.get(dil, []):
        metin = desen.sub(yerine, metin)
    return metin


def dil_bul(metin: str) -> str:
    d = algilayici.detect_language_of(metin)
    return DILLER.get(d, VARSAYILAN_DIL)


def azami_sure(metin: str) -> float:
    """Metnin makul en uzun okunma süresi (sn). Model bazen metin bitince
    uydurma konuşmaya devam ediyor; üretim bu süreyle sınırlanır (hem uydurma
    kesilir hem de boşa üretim yapılmadığı için hızlanır)."""
    return 0.8 + len(metin) / 9.0   # Türkçe konuşma ~13 harf/sn; %40 pay


def uret(metin: str, dil: str) -> np.ndarray:
    """chatterbox ChatterboxMultilingualTTS.generate ile aynı akış; tek fark
    konuşma belirteci sayısının metin uzunluğuna göre sınırlanması."""
    with kilit:
        ozel = dil in sesler
        model.conds = sesler.get(dil, varsayilan_ses)
        # Varsayılan ses İngilizce konuşan biri; dile özel kayıt yoksa aksanı
        # azaltmak için modelin önerisi cfg_weight=0
        cfg = CFG if (ozel or dil == "en") else 0.0
        if float(ABARTI) != float(model.conds.t3.emotion_adv[0, 0, 0].item()):
            c = model.conds.t3
            model.conds.t3 = T3Cond(
                speaker_emb=c.speaker_emb,
                cond_prompt_speech_tokens=c.cond_prompt_speech_tokens,
                emotion_adv=ABARTI * torch.ones(1, 1, 1),
            ).to(device=model.device)
        en_cok = int(25 * azami_sure(metin))   # S3 belirteçleri saniyede 25 adet
        metin_n = punc_norm(metin)
        tt = model.tokenizer.text_to_tokens(metin_n, language_id=dil).to(model.device)
        tt = torch.cat([tt, tt], dim=0)  # CFG için iki dizi
        tt = F.pad(tt, (1, 0), value=model.t3.hp.start_text_token)
        tt = F.pad(tt, (0, 1), value=model.t3.hp.stop_text_token)
        with torch.inference_mode():
            st = model.t3.inference(
                t3_cond=model.conds.t3, text_tokens=tt, max_new_tokens=en_cok,
                temperature=SICAKLIK, cfg_weight=cfg, repetition_penalty=2.0, min_p=0.05, top_p=1.0,
            )
            st = drop_invalid_tokens(st[0]).to(model.device)
            wav, _ = model.s3gen.inference(speech_tokens=st, ref_dict=model.conds.gen)
            wav = wav.squeeze(0).detach().cpu().numpy()
            wav = model.watermarker.apply_watermark(wav, sample_rate=model.sr)
        wav = torch.from_numpy(wav).unsqueeze(0)
    wav = wav.squeeze(0).numpy()
    wav = wav[: int(azami_sure(metin) * model.sr)]
    if TEMIZLE:
        wav = temizle(wav, model.sr)
    # Cümle başı/sonunda çıt sesi olmasın: 10 ms yumuşak giriş/çıkış
    n = min(len(wav) // 2, int(model.sr * 0.01))
    if n > 0:
        rampa = np.linspace(0.0, 1.0, n, dtype=wav.dtype)
        wav[:n] *= rampa
        wav[-n:] *= rampa[::-1]
    return wav


def parcala(metin: str) -> list[str]:
    """Uzun metni okunacak parçalara böler: ilk parça kısa (çabuk üretilsin,
    misafir hemen duysun), sonrakiler daha uzun. Önce cümle sonu, sonra
    virgül; ikisi de yoksa kelime sayısında bölünür. Çok kısa artık bırakılmaz."""
    kelimeler = metin.split()
    parcalar, simdiki = [], []
    for i, k in enumerate(kelimeler):
        simdiki.append(k)
        sinir = 6 if not parcalar else 14
        kalan = len(kelimeler) - i - 1
        n = len(simdiki)
        if kalan < 3:
            continue  # sona 1-2 kelime kalmasın
        if (re.search(r"[.!?…]$", k) and n >= 2) or (re.search(r"[,;:]$", k) and n >= sinir // 2) or n >= sinir:
            parcalar.append(" ".join(simdiki))
            simdiki = []
    if simdiki:
        parcalar.append(" ".join(simdiki))
    return parcalar


def pcm(wav: np.ndarray) -> bytes:
    return (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2").tobytes()


# Sık kullanılan kısa cevapların sesi hazırda bekler: "Tabii." anında çalar
onbellek: dict[tuple[str, str], bytes] = {}
HAZIR_CUMLELER = {
    "tr": ["Tabii.", "Tabii ki.", "Elbette.", "Hemen bakıyorum.", "Hemen ilgileniyorum.", "Rica ederim.",
           "Anladım.", "Bir saniye.", "Memnuniyetle.", "Teşekkürler.", "Teşekkür ederim.", "Peki.",
           "Doğru mu?", "Oda numaranız nedir?", "Keyifli tatiller dilerim.", "Görüşmek üzere.",
           "Keyifli bir konaklama dilerim.", "Başka bir isteğiniz var mı?"],
    "en": ["Sure.", "Of course.", "Certainly.", "Let me check.", "You're welcome.", "Got it."],
}
KISA = 5  # bu kadar kelimeye kadar olan cümleler önbelleğe alınır


def anahtar(metin: str, dil: str) -> tuple[str, str]:
    return (" ".join(metin.split()).lower(), dil)


def isit():
    for dil, cumleler in HAZIR_CUMLELER.items():
        for c in cumleler:
            try:
                onbellek[anahtar(c, dil)] = pcm(uret(soyle(c, dil), dil))
            except Exception as e:  # noqa: BLE001
                log.warning("Hazır cümle üretilemedi (%s): %s", c, e)
    log.info("Hazır cümleler: %d adet", len(onbellek))


app = FastAPI()


@app.on_event("startup")
async def baslangic():
    threading.Thread(target=isit, daemon=True).start()


@app.get("/health")
async def health():
    return {"ok": True, "cihaz": cihaz, "sesler": sorted(sesler), "hazir": len(onbellek)}


@app.post("/v1/audio/speech")
async def speech(req: Request):
    govde = await req.json()
    metin = str(govde.get("input", "")).strip()
    if not metin:
        return JSONResponse({"error": "input boş"}, status_code=400)
    dil = str(govde.get("language") or dil_bul(metin))
    basliklar = {"X-Sample-Rate": str(model.sr)}

    a = anahtar(metin, dil)
    if a in onbellek:
        log.info("%s | hazırdan | %s", dil, metin[:60])
        return Response(onbellek[a], media_type="audio/pcm", headers=basliklar)

    parcalar = parcala(metin)

    async def akis():
        t = time.time()
        toplam = 0
        for i, p in enumerate(parcalar):
            wav = await run_in_threadpool(uret, soyle(p, dil), dil)
            veri = pcm(wav)
            toplam += len(wav)
            if i == 0:
                log.info("%s | ilk parça %.2f sn'de hazır | %s", dil, time.time() - t, p[:40])
            yield veri
        log.info("%s | %.2f sn ses, %.2f sn sürdü, %d parça | %s",
                 dil, toplam / model.sr, time.time() - t, len(parcalar), metin[:60])
        if len(parcalar) == 1 and len(metin.split()) <= KISA and len(onbellek) < 500:
            onbellek[a] = veri

    return StreamingResponse(akis(), media_type="audio/pcm", headers=basliklar)
