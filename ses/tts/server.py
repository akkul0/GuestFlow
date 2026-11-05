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
import os
import threading
import time

import numpy as np
import torch
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from lingua import Language, LanguageDetectorBuilder

import torchaudio
from silero_vad import get_speech_timestamps, load_silero_vad

from chatterbox.mtl_tts import ChatterboxMultilingualTTS

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


def dil_bul(metin: str) -> str:
    d = algilayici.detect_language_of(metin)
    return DILLER.get(d, VARSAYILAN_DIL)


def uret(metin: str, dil: str) -> np.ndarray:
    with kilit:
        ozel = dil in sesler
        model.conds = sesler.get(dil, varsayilan_ses)
        wav = model.generate(
            metin,
            language_id=dil,
            exaggeration=ABARTI,
            temperature=SICAKLIK,
            # Varsayılan ses İngilizce konuşan biri; dile özel kayıt yoksa aksanı
            # azaltmak için modelin önerisi cfg_weight=0
            cfg_weight=CFG if (ozel or dil == "en") else 0.0,
        )
    wav = wav.squeeze(0).numpy()
    if TEMIZLE:
        wav = temizle(wav, model.sr)
    # Cümle başı/sonunda çıt sesi olmasın: 10 ms yumuşak giriş/çıkış
    n = min(len(wav) // 2, int(model.sr * 0.01))
    if n > 0:
        rampa = np.linspace(0.0, 1.0, n, dtype=wav.dtype)
        wav[:n] *= rampa
        wav[-n:] *= rampa[::-1]
    return wav


app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True, "cihaz": cihaz, "sesler": sorted(sesler)}


@app.post("/v1/audio/speech")
async def speech(req: Request):
    govde = await req.json()
    metin = str(govde.get("input", "")).strip()
    if not metin:
        return JSONResponse({"error": "input boş"}, status_code=400)
    dil = str(govde.get("language") or dil_bul(metin))
    t = time.time()
    wav = await run_in_threadpool(uret, metin, dil)
    pcm = (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    log.info("%s | %.2f sn ses, %.2f sn sürdü | %s", dil, len(wav) / model.sr, time.time() - t, metin[:60])
    return Response(pcm, media_type="audio/pcm", headers={"X-Sample-Rate": str(model.sr)})
