# Ses asistanı (telefon) — ElevenLabs'in yerine, sunucuda çalışır

- `asistan/` — konuşmayı yöneten bot (Pipecat): Whisper → yerel dil modeli → sesli cevap.
  Görüşme bitince dökümü backend'e (`/api/v1/voice/call-ended`) gönderir.
- `tts/` — metinden sese servisi (Chatterbox Multilingual, MIT). TR/EN/DE/RU.

Sunucu bunları `stayline-sunucu/docker-compose.yml` içindeki `ses` ve `tts`
servisleriyle derler. Güncelleme:

    cd ~/stayline-sunucu && git -C GuestFlow pull && docker compose up -d --build ses tts

Backend imajına girmez (`.dockerignore`).
