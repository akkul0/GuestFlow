#!/bin/sh
# Ayarları ortam değişkenlerinden üretip Asterisk'i başlatır.
#
# Netgsm hattı (isteğe bağlı; gelen dış aramalar):
#   SANTRAL_SIP_SUNUCU   Netgsm SIP sunucusu (ör. sip.netgsm.com.tr)
#   SANTRAL_SIP_PORT     varsayılan 5060
#   SANTRAL_SIP_KULLANICI, SANTRAL_SIP_SIFRE   hattın/dahilinin bilgileri
#   SANTRAL_SIP_ALAN     SIP alan adı (domain); boşsa sunucu adı
#   SANTRAL_DIS_IP       statik IP gelince (isteğe bağlı)
# Masa telefonu (isteğe bağlı; IP telefon doğrudan bu santrale kaydolur):
#   MASA_SIFRE           "masa" hesabının şifresi; ahize kalkınca asistana bağlanır
set -eu
AUDIOSOCKET=${SES_AUDIOSOCKET:-127.0.0.1:9092}
C=/etc/asterisk
NETGSM=""
[ -n "${SANTRAL_SIP_SUNUCU:-}" ] && [ -n "${SANTRAL_SIP_KULLANICI:-}" ] && [ -n "${SANTRAL_SIP_SIFRE:-}" ] && NETGSM=1
if [ -z "$NETGSM" ] && [ -z "${MASA_SIFRE:-}" ]; then
  echo "Ne Netgsm hattı ne masa telefonu tanımlı (SANTRAL_SIP_* ya da MASA_SIFRE)"; exit 1
fi
PORT=${SANTRAL_SIP_PORT:-5060}
ALAN=${SANTRAL_SIP_ALAN:-${SANTRAL_SIP_SUNUCU:-}}

DIS=""
if [ -n "${SANTRAL_DIS_IP:-}" ]; then
  DIS="external_media_address=$SANTRAL_DIS_IP
external_signaling_address=$SANTRAL_DIS_IP
local_net=192.168.0.0/16
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=100.64.0.0/10"
fi

cat > $C/pjsip.conf <<CONF
[global]
type=global
user_agent=StayLine

[udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
$DIS
CONF

if [ -n "$NETGSM" ]; then
cat >> $C/pjsip.conf <<CONF

[netgsm-auth]
type=auth
auth_type=userpass
username=$SANTRAL_SIP_KULLANICI
password=$SANTRAL_SIP_SIFRE

[netgsm-kayit]
type=registration
transport=udp
outbound_auth=netgsm-auth
server_uri=sip:$SANTRAL_SIP_SUNUCU:$PORT
client_uri=sip:$SANTRAL_SIP_KULLANICI@$ALAN
contact_user=$SANTRAL_SIP_KULLANICI
expiration=120
retry_interval=20
forbidden_retry_interval=120
max_retries=10000
line=yes
endpoint=netgsm

[netgsm]
type=aor
contact=sip:$SANTRAL_SIP_SUNUCU:$PORT
qualify_frequency=25

[netgsm]
type=endpoint
transport=udp
context=gelen
disallow=all
allow=alaw,ulaw
outbound_auth=netgsm-auth
aors=netgsm
from_user=$SANTRAL_SIP_KULLANICI
from_domain=$ALAN
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc4733

[netgsm-tanima]
type=identify
endpoint=netgsm
match=$SANTRAL_SIP_SUNUCU
CONF
fi

if [ -n "${MASA_SIFRE:-}" ]; then
cat >> $C/pjsip.conf <<CONF

[masa]
type=auth
auth_type=userpass
username=masa
password=$MASA_SIFRE

[masa]
type=aor
max_contacts=2
remove_existing=yes
qualify_frequency=30

[masa]
type=endpoint
transport=udp
context=masa
disallow=all
allow=alaw,ulaw
auth=masa
aors=masa
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc4733
CONF
fi

cat > $C/extensions.conf <<CONF
[general]
static=yes
writeprotect=yes

[gelen]
exten => s,1,Goto(asistan,1)
exten => _.,1,Goto(asistan,1)
exten => asistan,1,NoOp(Gelen arama: \${CALLERID(num)})
 same => n,Answer()
 same => n,Wait(0.5)
 same => n,AudioSocket(40325ec2-5efd-4bd3-805f-53576e581d13,$AUDIOSOCKET)
 same => n,Hangup()

[masa]
; Masa telefonu: hangi numarayı çevirirse çevirsin (ya da ahize kalkınca) asistana
exten => _.,1,Goto(gelen,asistan,1)
exten => s,1,Goto(gelen,asistan,1)
CONF

cat > $C/rtp.conf <<CONF
[general]
rtpstart=10000
rtpend=10200
CONF

cat > $C/logger.conf <<CONF
[logfiles]
console => notice,warning,error,verbose
CONF

# Kullanılmayan, gürültü çıkaran modüller
cat > $C/modules.conf <<CONF
[modules]
autoload=yes
noload => chan_sip.so
noload => chan_iax2.so
noload => pbx_dundi.so
noload => cel_tds.so
noload => cel_pgsql.so
noload => cdr_pgsql.so
noload => cdr_tds.so
noload => res_phoneprov.so
noload => res_pjsip_phoneprov_provider.so
noload => app_voicemail.so
noload => app_voicemail_odbc.so
noload => app_voicemail_imap.so
noload => chan_unistim.so
noload => chan_mgcp.so
noload => chan_skinny.so
noload => res_hep.so
noload => res_hep_pjsip.so
noload => res_hep_rtcp.so
noload => cdr_radius.so
noload => cel_radius.so
noload => res_config_pgsql.so
noload => res_config_ldap.so
noload => res_geolocation.so
noload => res_pjsip_geolocation.so
CONF

[ -n "$NETGSM" ] && echo "Netgsm hattı: $SANTRAL_SIP_KULLANICI@$ALAN → $SANTRAL_SIP_SUNUCU:$PORT"
[ -n "${MASA_SIFRE:-}" ] && echo "Masa telefonu hesabı: masa"
exec asterisk -f -vvv
