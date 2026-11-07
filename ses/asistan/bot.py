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
from pipecat.audio.vad.vad_analyzer import VADParams
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
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

API = os.getenv("SES_API_URL", "http://127.0.0.1:8080/api/v1")
SIR = os.getenv("VOICE_API_SECRET", "")
AJAN = os.getenv("SES_AJAN_KIMLIGI", "")
LLM_URL = os.getenv("SES_LLM_URL", "http://127.0.0.1:11434")
LLM_MODEL = os.getenv("LOCAL_LLM_MODEL") or "gemma4:26b-a4b-it-qat"
STT_URL = os.getenv("SES_STT_URL", "http://127.0.0.1:8001/v1")
STT_MODEL = os.getenv("WHISPER_MODEL") or "Systran/faster-whisper-large-v3"
TTS_URL = os.getenv("SES_TTS_URL", "http://127.0.0.1:8002/v1")
SUSMA_SURESI = float(os.getenv("SES_SUSMA_SURESI", "0.5"))  # misafir susunca kaç sn sonra cevap


DIL_ADLARI = {"turkish": "tr", "english": "en", "german": "de", "russian": "ru"}
# Telefonda konuşulacak diller (virgülle). Tek dil verilirse dil algılanmaz,
# her şey o dilde çözülür ve konuşulur (gürültülü ortamda en sağlamı).
IZINLI_DILLER = {d.strip() for d in os.getenv("SES_DILLER", "tr,en,de,ru").split(",") if d.strip()}
VARSAYILAN_DIL = os.getenv("SES_VARSAYILAN_DIL", "tr")
# Whisper'a ipucu: otelde sık geçen kelimeleri doğru yazsın ("spa" → "Sıpa" olmasın)
TR_IPUCU = "Otel telefon görüşmesi. Oda numaram 2122. Spa, hamam, sauna, havuz, aquapark, kahvaltı, restoran, resepsiyon, havlu, oda servisi, klima, minibar."


class OtomatikDilSTT(OpenAISTTService):
    """Misafirin dilini her cümlede algılar; kısa ya da şüpheli cümlelerde görüşmenin dilinde kalır.

    Kısa cümlelerde Whisper dili şaşırabiliyor (Türkçe "spa saat kaçta"yı Rusça
    sanmak gibi). Kural: algılanan dil izinli dillerden biriyse ve ya görüşmenin
    şu anki diliyle aynıysa ya da cümle en az 3 kelimeyse kabul edilir (misafir
    İngilizceye geçerse görüşme de geçer). Değilse cümle görüşmenin dilinde
    (başta Türkçe) yeniden çözülür. Türkçede otel kelimeleri ipucu olarak verilir.
    """

    kilit: str | None = None

    async def _cevir(self, audio: bytes, dil: str | None, **ek):
        kw = {"file": ("audio.wav", audio, "audio/wav"), "model": STT_MODEL, **ek}
        if dil:
            kw["language"] = dil
        if dil in (None, "tr"):
            kw["prompt"] = TR_IPUCU
        return await self._client.audio.transcriptions.create(**kw)

    async def _transcribe(self, audio: bytes):
        if len(IZINLI_DILLER) == 1:
            return await self._cevir(audio, next(iter(IZINLI_DILLER)))
        # Tek geçiş: dil algılama + yazıya çevirme. İpucu (otel kelimeleri) dil
        # algılamayı etkilemez, yalnızca yazımı düzeltir.
        mevcut = self.kilit or VARSAYILAN_DIL
        r = await self._cevir(audio, None, response_format="verbose_json")
        ham = str(getattr(r, "language", "") or "").lower()
        dil = DIL_ADLARI.get(ham, ham[:2])
        kelime = len((r.text or "").split())
        if dil in IZINLI_DILLER and (dil == mevcut or kelime >= 3):
            if dil != self.kilit:
                logger.info(f"Görüşme dili: {dil}")
                self.kilit = dil
            return r
        logger.info(f"Şüpheli dil ({ham}, {kelime} kelime); {mevcut} olarak yeniden çözülüyor")
        return await self._cevir(audio, mevcut)


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


def dil_kurali() -> str:
    if IZINLI_DILLER == {"tr"}:
        return "- HER ZAMAN Türkçe konuş. Misafir başka dilde konuşsa da Türkçe cevap ver."
    return "- Misafir hangi dilde konuşuyorsa o dilde cevap ver (Türkçe, İngilizce, Almanca, Rusça...)."


def sistem_metni(otel: str, bilgi: str) -> str:
    return f"""Sen {otel} otelinin telefon asistanısın. Misafirler oda telefonundan arıyor.

KURALLAR
- Cevapların sesli okunacak: en fazla iki kısa cümle. Liste, emoji, yıldız, parantez kullanma.
- Cevaba HER ZAMAN 1-3 kelimelik çok kısa bir cümleyle başla ("Tabii." "Hemen bakıyorum." "Elbette."),
  ayrıntıyı ikinci cümlede ver. Böylece misafir beklemeden sesini duyar.
{dil_kurali()}
- Saatleri ve sayıları yazıyla yaz (ör. "sabah yedi", "üç yüz beş"); rakam kullanma.
- Misafir bir şey isterse (havlu, temizlik, arıza, oda servisi, uyandırma, şikâyet):
  1. Oda numarasını henüz bilmiyorsan YALNIZCA oda numarasını sor. Bu adımda talebin
     iletildiğini SÖYLEME.
  2. Oda numarasını duyunca SADECE teyit sorusunu sor ve misafirin cevabını bekle. Bu cevaba
     başka hiçbir şey ekleme (ör. yalnızca: "Yirmi bir yirmi iki numaralı oda, doğru mu?").
  3. Misafir "evet" deyince talebin ilgili ekibe iletildiğini ve kısa sürede ilgilenileceğini söyle.
     Misafir "hayır" derse numarayı tekrar sor.

ÖRNEK
Misafir: Klimam çalışmıyor.
Sen: Hemen yardımcı olayım. Kaç numaralı odada kalıyorsunuz?
Misafir: Yirmi bir yirmi iki.
Sen: Yirmi bir yirmi iki numaralı oda, doğru mu?
Misafir: Evet.
Sen: Teşekkürler, teknik ekibimize ilettim; kısa sürede odanıza gelecekler.
  Oda numarası anlaşılmadıysa tahmin etme, tekrar söylemesini rica et.
  Talepleri sen kaydetmiyorsun; görüşme bitince sistem otomatik kaydeder.
- Bilmediğin bir şeyi uydurma; "resepsiyon size yardımcı olacak" de.
- Fiyat, indirim veya ücretsiz hizmet sözü verme.

OTEL BİLGİLERİ
{bilgi or '(bilgi bankası boş)'}"""


def karsilama_metni(otel: str) -> str:
    return f"{otel}, iyi günler, size nasıl yardımcı olabilirim?"


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


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments | None = None, telefon: bool = False) -> None:
    """telefon=False: tarayıcı testi (WebRTC). telefon=True: santralden gelen gerçek arama."""
    gorusme = f"{'tel' if telefon else 'yerel'}-{uuid.uuid4()}"
    otel, bilgi = await otel_bilgisi()
    logger.info(f"Görüşme başladı: {gorusme} ({otel})")

    stt = OtomatikDilSTT(api_key="yerel", base_url=STT_URL, settings=OpenAISTTService.Settings(model=STT_MODEL))
    tts = OpenAITTSService(
        api_key="yerel",
        base_url=TTS_URL,
        settings=OpenAITTSService.Settings(voice="alloy", model="chatterbox"),
        sample_rate=24000,  # ses servisi her zaman 24 kHz döndürür
    )
    ayarlar = OLLamaLLMService.Settings(model=LLM_MODEL, system_instruction=sistem_metni(otel, bilgi))
    if await dusunme_kapatilabilir_mi():
        ayarlar.extra = {"reasoning_effort": "none"}
    llm = OLLamaLLMService(base_url=f"{LLM_URL}/v1", settings=ayarlar)

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            # Gürültülü ortam (fuar, lobi): daha emin olmadan konuşma sayma
            vad_analyzer=SileroVADAnalyzer(params=VADParams(
                confidence=float(os.getenv("SES_VAD_GUVEN", "0.8")),
                start_secs=float(os.getenv("SES_VAD_BASLA", "0.3")),
                min_volume=float(os.getenv("SES_VAD_SES", "0.65")),
            )),
            # Misafir susunca 0,5 sn bekleyip cevaba geç (varsayılan "akıllı bitiş"
            # algılayıcısı Türkçe cümleleri yarım sanıp saniyelerce bekleyebiliyor)
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=SUSMA_SURESI)]
            ),
        ),
    )

    pipeline = Pipeline(
        [transport.input(), stt, user_aggregator, llm, tts, transport.output(), assistant_aggregator]
    )
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True), observers=[])
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint if runner_args else False)
    await runner.add_workers(worker)

    async def karsila_hazir():
        # Telefonda karşılama sesi köprüden hazır çalınır (bekletmemek için);
        # modelin bağlamına yalnızca söylendiği yazılır.
        context.add_message({"role": "assistant", "content": karsilama_metni(otel)})

    async def karsila():
        context.add_message({
            "role": "developer",
            "content": f"Misafiri Türkçe olarak kısaca karşıla: '{otel}, iyi günler, size nasıl yardımcı olabilirim?'",
        })
        await worker.queue_frames([LLMRunFrame()])

    if telefon:
        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            await karsila_hazir()
    else:
        @worker.rtvi.event_handler("on_client_ready")
        async def on_client_ready(rtvi):
            await karsila()

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
