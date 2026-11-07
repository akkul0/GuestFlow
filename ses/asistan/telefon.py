"""
Telefon köprüsü: santral (Asterisk) → ses asistanı.

  Netgsm numarası → Asterisk (SIP) → AudioSocket (TCP, 127.0.0.1:9092)
  → bu köprü → WebSocket (127.0.0.1:7870/ws) → Pipecat (bot.run_bot)

AudioSocket protokolü (Asterisk): her mesaj 1 bayt tür + 2 bayt uzunluk
(büyük uçlu) + veri. Türler: 0x00 kapat, 0x01 UUID, 0x03 DTMF,
0x10 ses (8 kHz, 16 bit, mono, küçük uçlu PCM; 20 ms = 320 bayt), 0xff hata.

Asistan sesi gerçek zamandan hızlı üretir; köprü bunu tamponlar ve
Asterisk'e 20 ms'de bir 320 bayt olarak gönderir. Misafir araya girince
(Pipecat "temizle" der) tampon boşaltılır, asistan hemen susar.
"""
import asyncio
import os
import struct

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, WebSocket
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

import bot

AUDIOSOCKET_PORT = int(os.getenv("SES_AUDIOSOCKET_PORT", "9092"))
WS_PORT = int(os.getenv("SES_TELEFON_WS_PORT", "7870"))
TEL_SR = 8000
KARE = 320  # 20 ms, 8 kHz, 16 bit

TUR_KAPAT, TUR_UUID, TUR_DTMF, TUR_SES, TUR_HATA = 0x00, 0x01, 0x03, 0x10, 0xFF

KARSILAMA_SES = b""  # 8 kHz PCM; açılışta bir kez üretilir


async def karsilama_hazirla():
    """Karşılama cümlesini bir kez sese çevirip saklar: arayan beklemeden duyar."""
    global KARSILAMA_SES
    otel, _ = await bot.otel_bilgisi()
    metin = bot.karsilama_metni(otel)
    for deneme in range(30):  # ses servisi açılışta model yüklüyor olabilir
        try:
            async with httpx.AsyncClient(timeout=120) as c:
                r = await c.post(f"{bot.TTS_URL}/audio/speech",
                                 json={"model": "chatterbox", "voice": "alloy", "input": metin, "language": "tr"})
                r.raise_for_status()
            KARSILAMA_SES = await create_stream_resampler().resample(r.content, 24000, TEL_SR)
            logger.info(f"Karşılama sesi hazır ({len(KARSILAMA_SES) / (TEL_SR * 2):.1f} sn): {metin}")
            return
        except Exception as e:
            logger.warning(f"Karşılama sesi üretilemedi ({deneme + 1}/30): {e}")
            await asyncio.sleep(10)


class HamPCM(FrameSerializer):
    """WebSocket üzerinde ham 8 kHz PCM. Araya girmede metin olarak 'temizle'."""

    def __init__(self):
        super().__init__()
        self._giris_hizi = 0
        self._giris = create_stream_resampler()
        self._cikis = create_stream_resampler()

    async def setup(self, setup: FrameProcessorSetup):
        self._giris_hizi = setup.audio_in_sample_rate

    async def serialize(self, frame: Frame):
        if isinstance(frame, InterruptionFrame):
            return "temizle"
        if isinstance(frame, OutputAudioRawFrame):
            veri = await self._cikis.resample(frame.audio, frame.sample_rate, TEL_SR)
            return veri or None
        return None

    async def deserialize(self, data):
        if isinstance(data, bytes) and data:
            veri = await self._giris.resample(data, TEL_SR, self._giris_hizi)
            if veri:
                return InputAudioRawFrame(audio=veri, num_channels=1, sample_rate=self._giris_hizi)
        return None


app = FastAPI()


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=HamPCM(),
        ),
    )
    await bot.run_bot(transport, None, telefon=True)


def paket(tur: int, veri: bytes = b"") -> bytes:
    return struct.pack(">BH", tur, len(veri)) + veri


async def arama(okuyucu: asyncio.StreamReader, yazici: asyncio.StreamWriter):
    """Asterisk'ten gelen tek bir arama."""
    logger.info("Telefon: yeni arama")
    tampon = bytearray(KARSILAMA_SES)  # karşılama hemen çalmaya başlar
    bitti = asyncio.Event()
    try:
        ws_baglanti = await websockets.connect(f"ws://127.0.0.1:{WS_PORT}/ws", max_size=None)
    except Exception as e:
        logger.error(f"Telefon: asistana bağlanılamadı: {e}")
        yazici.write(paket(TUR_KAPAT))
        await yazici.drain()
        yazici.close()
        return

    async def santralden():
        try:
            while not bitti.is_set():
                baslik = await okuyucu.readexactly(3)
                tur, uzunluk = struct.unpack(">BH", baslik)
                veri = await okuyucu.readexactly(uzunluk) if uzunluk else b""
                if tur == TUR_SES:
                    await ws_baglanti.send(veri)
                elif tur == TUR_KAPAT:
                    logger.info("Telefon: misafir kapattı")
                    break
                elif tur == TUR_HATA:
                    logger.warning(f"Telefon: santral hata bildirdi: {veri.hex()}")
                    break
                # UUID ve DTMF şimdilik kullanılmıyor
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            bitti.set()

    async def asistandan():
        try:
            async for mesaj in ws_baglanti:
                if isinstance(mesaj, bytes):
                    tampon.extend(mesaj)
                elif mesaj == "temizle":
                    tampon.clear()
        except websockets.ConnectionClosed:
            pass
        finally:
            bitti.set()

    async def zamanlayici():
        """Sesi gerçek zamanda, 20 ms'lik parçalarla santrale ver."""
        dongu = asyncio.get_running_loop()
        sonraki = dongu.time()
        try:
            while not bitti.is_set():
                if len(tampon) >= KARE:
                    parca = bytes(tampon[:KARE])
                    del tampon[:KARE]
                    yazici.write(paket(TUR_SES, parca))
                    await yazici.drain()
                sonraki += 0.02
                await asyncio.sleep(max(0, sonraki - dongu.time()))
                if sonraki < dongu.time() - 0.2:  # geride kaldıysa saati düzelt
                    sonraki = dongu.time()
        except ConnectionError:
            bitti.set()

    gorevler = [asyncio.create_task(g()) for g in (santralden, asistandan, zamanlayici)]
    await bitti.wait()
    for g in gorevler:
        g.cancel()
    try:
        await ws_baglanti.close()
    except Exception:
        pass
    try:
        yazici.write(paket(TUR_KAPAT))
        await yazici.drain()
        yazici.close()
    except Exception:
        pass
    logger.info("Telefon: arama bitti")


async def main():
    sunucu = await asyncio.start_server(arama, "127.0.0.1", AUDIOSOCKET_PORT)
    logger.info(f"Telefon köprüsü hazır: AudioSocket 127.0.0.1:{AUDIOSOCKET_PORT}")
    config = uvicorn.Config(app, host="127.0.0.1", port=WS_PORT, log_level="warning")
    asyncio.create_task(karsilama_hazirla())
    await asyncio.gather(sunucu.serve_forever(), uvicorn.Server(config).serve())


if __name__ == "__main__":
    asyncio.run(main())
