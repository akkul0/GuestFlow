"""
StayLine ses asistanı — ElevenLabs'in yerine, tamamen bu sunucuda çalışır.

  misafir konuşur → Whisper (yazıya çevirir) → Gemma (cevabı yazar)
  → Chatterbox (sese çevirir) → misafir duyar

Çağrı bitince konuşma dökümü backend'e gönderilir (/voice/call-ended,
ElevenLabs'in gönderdiği biçimin aynısı); talepler oradan sipariş olarak
açılır ve ilgili personele WhatsApp bildirimi gider.

Şimdilik tarayıcıdan test edilir: http://127.0.0.1:7860
(yalnızca bu bilgisayardan açılır). Oda telefonu bağlantısı sonra eklenecek.
"""
import os
import uuid

import httpx
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.workers.runner import WorkerRunner

API = os.getenv("SES_API_URL", "http://127.0.0.1:8080/api/v1")
SIR = os.getenv("VOICE_API_SECRET", "")
AJAN = os.getenv("SES_AJAN_KIMLIGI", "")
LLM_URL = os.getenv("SES_LLM_URL", "http://127.0.0.1:11434")
LLM_MODEL = os.getenv("LOCAL_LLM_MODEL") or "gemma4:26b-a4b-it-qat"
STT_URL = os.getenv("SES_STT_URL", "http://127.0.0.1:8001/v1")
STT_MODEL = os.getenv("WHISPER_MODEL") or "Systran/faster-whisper-large-v3"
TTS_URL = os.getenv("SES_TTS_URL", "http://127.0.0.1:8002/v1")


DIL_ADLARI = {"turkish": "tr", "english": "en", "german": "de", "russian": "ru"}
IZINLI_DILLER = {"tr", "en", "de", "ru"}
VARSAYILAN_DIL = os.getenv("SES_VARSAYILAN_DIL", "tr")
# Whisper'a ipucu: otelde sık geçen kelimeleri doğru yazsın ("spa" → "Sıpa" olmasın)
TR_IPUCU = "Otel telefon görüşmesi. Spa, hamam, sauna, havuz, aquapark, kahvaltı, restoran, resepsiyon, havlu, oda servisi, klima, minibar."


class OtomatikDilSTT(OpenAISTTService):
    """Misafirin dilini ilk anlamlı cümlesinden bulur ve görüşme boyunca o dilde kalır.

    Kısa cümlelerde Whisper dili şaşırabiliyor (Türkçe "spa saat kaçta"yı Rusça
    sanmak gibi). Bu yüzden: dil, en az 3 kelimelik ve izinli dillerden biri olarak
    algılanan ilk cümlede kilitlenir; kilitlenene kadar tanımsız/şüpheli sonuçlar
    varsayılan dilde (Türkçe) yeniden çözülür.
    """

    kilit: str | None = None

    async def _cevir(self, audio: bytes, dil: str | None, **ek):
        kw = {"file": ("audio.wav", audio, "audio/wav"), "model": STT_MODEL, **ek}
        if dil:
            kw["language"] = dil
            if dil == "tr":
                kw["prompt"] = TR_IPUCU
        return await self._client.audio.transcriptions.create(**kw)

    async def _transcribe(self, audio: bytes):
        if self.kilit:
            return await self._cevir(audio, self.kilit)
        r = await self._cevir(audio, None, response_format="verbose_json")
        ham = str(getattr(r, "language", "") or "").lower()
        dil = DIL_ADLARI.get(ham, ham[:2])
        kelime = len((r.text or "").split())
        if dil in IZINLI_DILLER and kelime >= 3:
            self.kilit = dil
            logger.info(f"Görüşme dili: {dil}")
            return r if dil != "tr" else await self._cevir(audio, "tr")
        if dil == VARSAYILAN_DIL:
            return await self._cevir(audio, VARSAYILAN_DIL)
        # Kısa ya da tanımsız: otel Türkiye'de, karşılama Türkçe → Türkçe say
        logger.info(f"Şüpheli dil ({ham}, {kelime} kelime); {VARSAYILAN_DIL} olarak yeniden çözülüyor")
        return await self._cevir(audio, VARSAYILAN_DIL)


async def otel_bilgisi() -> tuple[str, str]:
    """Otelin adı ve bilgi bankası (backend'den)."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{API}/voice/context", params={"agentId": AJAN}, headers={"x-voice-secret": SIR})
            r.raise_for_status()
            d = r.json()
            return d.get("hotelName") or "otelimiz", d.get("knowledge") or ""
    except Exception as e:
        logger.error(f"Otel bilgisi alınamadı (ajan kimliği: {AJAN}). Otelin ajan kimliği bu değere ayarlı mı? Hata: {e}")
        return "otelimiz", ""


async def dusunme_kapatilabilir_mi() -> bool:
    """Model 'düşünme' modunu kapatmayı destekliyor mu (yavaşlığı önler)."""
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"{LLM_URL}/v1/chat/completions",
                json={"model": LLM_MODEL, "messages": [{"role": "user", "content": "1"}],
                      "max_tokens": 1, "reasoning_effort": "none"},
            )
            return r.status_code == 200
    except Exception:
        return False


def sistem_metni(otel: str, bilgi: str) -> str:
    return f"""Sen {otel} otelinin telefon asistanısın. Misafirler oda telefonundan arıyor.

KURALLAR
- Cevapların sesli okunacak: en fazla iki kısa cümle. Liste, emoji, yıldız, parantez kullanma.
- Misafir hangi dilde konuşuyorsa o dilde cevap ver (Türkçe, İngilizce, Almanca, Rusça...).
- Saatleri ve sayıları yazıyla yaz (ör. "sabah yedi", "üç yüz beş"); rakam kullanma.
- Misafir bir şey isterse (havlu, temizlik, arıza, oda servisi, uyandırma, şikâyet) oda numarasını
  bilmiyorsan sor; sonra talebin ilgili ekibe iletildiğini ve kısa sürede ilgilenileceğini söyle.
  Talepleri sen kaydetmiyorsun; görüşme bitince sistem otomatik kaydeder.
- Bilmediğin bir şeyi uydurma; "resepsiyon size yardımcı olacak" de.
- Fiyat, indirim veya ücretsiz hizmet sözü verme.

OTEL BİLGİLERİ
{bilgi or '(bilgi bankası boş)'}"""


async def dokumu_gonder(context: LLMContext, gorusme: str) -> None:
    turns = []
    for m in context.get_messages():
        rol = m.get("role") if isinstance(m, dict) else None
        icerik = m.get("content") if isinstance(m, dict) else None
        if isinstance(icerik, list):
            icerik = " ".join(p.get("text", "") for p in icerik if isinstance(p, dict))
        if rol in ("user", "assistant") and icerik and str(icerik).strip():
            turns.append({"role": "user" if rol == "user" else "agent", "message": str(icerik).strip()})
    if not any(t["role"] == "user" for t in turns):
        logger.info("Misafir hiç konuşmadı; döküm gönderilmedi")
        return
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{API}/voice/call-ended",
                headers={"x-voice-secret": SIR},
                json={"type": "post_call_transcription",
                      "data": {"transcript": turns, "conversation_id": gorusme, "agent_id": AJAN}},
            )
            logger.info(f"Döküm gönderildi ({len(turns)} satır): {r.status_code} {r.text[:120]}")
    except Exception as e:
        logger.error(f"Döküm gönderilemedi: {e}")


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:
    gorusme = f"yerel-{uuid.uuid4()}"
    otel, bilgi = await otel_bilgisi()
    logger.info(f"Görüşme başladı: {gorusme} ({otel})")

    stt = OtomatikDilSTT(api_key="yerel", base_url=STT_URL, settings=OpenAISTTService.Settings(model=STT_MODEL))
    tts = OpenAITTSService(
        api_key="yerel",
        base_url=TTS_URL,
        settings=OpenAITTSService.Settings(voice="alloy", model="chatterbox"),
    )
    ayarlar = OLLamaLLMService.Settings(model=LLM_MODEL, system_instruction=sistem_metni(otel, bilgi))
    if await dusunme_kapatilabilir_mi():
        ayarlar.extra = {"reasoning_effort": "none"}
    llm = OLLamaLLMService(base_url=f"{LLM_URL}/v1", settings=ayarlar)

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [transport.input(), stt, user_aggregator, llm, tts, transport.output(), assistant_aggregator]
    )
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True), observers=[])
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)

    @worker.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        context.add_message({
            "role": "developer",
            "content": f"Misafiri Türkçe olarak kısaca karşıla: '{otel}, iyi günler, size nasıl yardımcı olabilirim?'",
        })
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Görüşme bitti")
        await dokumu_gonder(context, gorusme)
        await runner.cancel()

    await runner.run()


async def bot(runner_args: RunnerArguments):
    transport = await create_transport(
        runner_args, {"webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)}
    )
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
