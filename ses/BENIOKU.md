# Ses asistanı (telefon) — ElevenLabs'in yerine, sunucuda çalışır

- `asistan/` — konuşmayı yöneten bot (Pipecat): Whisper → yerel dil modeli → sesli cevap.
  Görüşme bitince dökümü backend'e (`/api/v1/voice/call-ended`) gönderir.
- `tts/` — metinden sese servisi (Chatterbox Multilingual, MIT). TR/EN/DE/RU.
- `santral/` — Asterisk: Netgsm'e SIP ile kayıt olur, gelen aramayı AudioSocket ile köprüye verir.
- `asistan/telefon.py` — santral (AudioSocket, 8 kHz) ile asistan arasındaki köprü.
- `compose.yml` — santral ve köprü servisleri (`.env`'de `COMPOSE_FILE` ile eklenir).
- `telefon-kur.sh` — Netgsm bilgilerini sorar, santrali kurar; `durum` ile bağlantıyı gösterir.

Sunucu bunları `stayline-sunucu/docker-compose.yml` içindeki `ses` ve `tts`
servisleriyle derler. Güncelleme:

    cd ~/stayline-sunucu && git -C GuestFlow pull && docker compose up -d --build ses tts

Backend imajına girmez (`.dockerignore`).
