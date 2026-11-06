#!/usr/bin/env bash
# Telefon hattını (Netgsm) ses asistanına bağlar.
#   ./GuestFlow/ses/telefon-kur.sh          ilk kurulum (SIP bilgilerini sorar)
#   ./GuestFlow/ses/telefon-kur.sh durum    bağlantı durumu
#   ./GuestFlow/ses/telefon-kur.sh guncelle kodu güncelleyip yeniden başlatır
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."   # stayline-sunucu
[ -f .env ] && [ -f docker-compose.yml ] || { echo "stayline-sunucu klasörü bulunamadı"; exit 1; }
if [ "$(id -u)" = "0" ] || id -nG | grep -qw docker; then DC="docker compose"; else DC="sudo docker compose"; fi

ayarla() { local t; t=$(mktemp); grep -v "^$1=" .env > "$t" || true; printf "%s='%s'\n" "$1" "$2" >> "$t"; cat "$t" > .env; rm -f "$t"; chmod 600 .env; }
oku() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d "'\"" || true; }
profil_ekle() { echo ",$(oku COMPOSE_PROFILES)," | grep -q ",$1," || { local p; p=$(oku COMPOSE_PROFILES); ayarla COMPOSE_PROFILES "${p:+$p,}$1"; }; }
tamam() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

durum() {
  echo "Netgsm bağlantısı:"
  $DC exec -T santral asterisk -rx "pjsip show registrations" | grep -E "netgsm|Objects" || true
  echo
  echo "Registered → hazır, numarayı arayabilirsiniz."
  echo "Rejected / No Auth → kullanıcı adı ya da şifre yanlış.  Unregistered → sunucuya ulaşılamıyor."
}

case "${1:-kur}" in
  durum) durum; exit 0 ;;
  guncelle)
    git -C GuestFlow pull -q
    $DC up -d --build santral telefon ses tts
    sleep 15; durum; exit 0 ;;
  kur) ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac

[ -n "$(oku VOICE_API_SECRET)" ] || { echo "Önce ses asistanını kurun: ./yapay-zeka.sh ses-kur"; exit 1; }

echo "Netgsm panelindeki dahili bilgilerini girin (şifre yazarken görünmez)."
read -r -p "  SIP sunucu adresi (ör. sip.netgsm.com.tr): " SUNUCU
read -r -p "  Kullanıcı adı: " KULLANICI
read -r -s -p "  Şifre: " SIFRE; echo
read -r -p "  SIP alan adı (domain) — panelde ayrıca yazıyorsa girin, yoksa Enter: " ALAN
[ -n "$SUNUCU" ] && [ -n "$KULLANICI" ] && [ -n "$SIFRE" ] || { echo "Eksik bilgi"; exit 1; }
case "$SIFRE" in *"'"*) echo "Şifrede tek tırnak (') olmamalı; Netgsm'den yeni şifre alın."; exit 1 ;; esac
ayarla SANTRAL_SIP_SUNUCU "$SUNUCU"
ayarla SANTRAL_SIP_KULLANICI "$KULLANICI"
ayarla SANTRAL_SIP_SIFRE "$SIFRE"
if [ -n "$ALAN" ]; then ayarla SANTRAL_SIP_ALAN "$ALAN"; fi
unset SIFRE
ayarla COMPOSE_FILE "docker-compose.yml:GuestFlow/ses/compose.yml"
profil_ekle telefon
tamam "ayarlar kaydedildi"

echo "Santral kuruluyor (ilk seferde birkaç dakika)…"
$DC up -d --build santral telefon
sleep 20
durum
