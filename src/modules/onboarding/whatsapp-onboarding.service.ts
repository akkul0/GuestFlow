import crypto from 'crypto'
import { FastifyInstance } from 'fastify'
import { createError } from '../../common/utils/errors'
import { raiseAlertInBackground } from '../../common/utils/alerts'
import {
  MetaGraphError,
  exchangeCode,
  listPhoneNumbers,
  getPhoneNumber,
  subscribeApp,
  unsubscribeApp,
  registerPhone,
} from './meta-graph'

// ─────────────────────────────────────────────────────────────
// WHATSAPP BAĞLANTISI (Embedded Signup — standart, Coexistence yok)
//
// Akış: panel Meta penceresini açar → otel yöneticisi hesabını ve
// numarasını seçer → pencere bize {code, wabaId, phoneNumberId} verir →
// burada:
//   1. kodu kalıcı token'a çevir           (kod 30 sn geçerli: ilk iş bu)
//   2. hesaptaki numaraları listele        (token bu hesaba erişiyor mu + numara bu hesapta mı)
//   3. numara başka otelde mi              (bir numara tek otele bağlanır)
//   4. webhook aboneliği                   (mesajlar StayLine'a gelsin)
//   5. numara kaydı                        (zaten kayıtlıysa ATLA — Meta 72 saatte 10 kayıtla sınırlıyor)
//   6. kaydet                              (token ve PIN şifreli; bkz. config/prisma.ts)
//
// Bağlantıyı kesmek numaranın kaydına DOKUNMAZ: sadece aboneliği kaldırır
// ve token'ı siler. Böylece istendiği kadar kesip yeniden bağlanılabilir.
// ─────────────────────────────────────────────────────────────

export interface ConnectInput {
  code: string
  wabaId: string
  phoneNumberId: string
}

function newPin(): string {
  // 6 haneli, kriptografik rastgele
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export class WhatsAppOnboardingService {
  constructor(private app: FastifyInstance) {}

  async connect(hotelId: string, input: ConnectInput, actorUserId: string) {
    const hotel = await this.app.prisma.hotel.findUnique({
      where: { id: hotelId },
      select: { id: true, waPhoneNumberId: true, waBusinessId: true, waRegistrationPin: true },
    })
    if (!hotel) throw createError(404, 'Otel bulunamadı')

    const wabaId = input.wabaId.trim()
    const phoneNumberId = input.phoneNumberId.trim()

    try {
      // 1. Kod → token. İlk adım: kodun ömrü 30 saniye.
      const token = await exchangeCode(input.code)

      // 2. Erişim + numara doğrulaması
      const phones = await listPhoneNumbers(token, wabaId)
      const phone = phones.find((p) => p.id === phoneNumberId)
      if (!phone) {
        throw createError(400, 'Seçilen numara bu WhatsApp hesabında bulunamadı. Bağlantı penceresinde numarayı tekrar seçin.')
      }

      // 3. Numara başka bir otele mi bağlı?
      const owner = await this.app.prisma.hotel.findFirst({
        where: { waPhoneNumberId: phoneNumberId, NOT: { id: hotelId } },
        select: { id: true },
      })
      if (owner) throw createError(409, 'Bu WhatsApp numarası başka bir otele bağlı.')

      // 4. Webhook aboneliği
      await subscribeApp(token, wabaId)

      // 5. Numara kaydı
      // Kayıt YALNIZCA gerçek bir yeniden bağlanmada atlanır: aynı otel, aynı
      // hesap (WABA), aynı numara ve numara zaten Cloud API'de kayıtlı. Meta
      // kaydı 72 saatte 10 ile sınırladığı için bu durumda gereksiz kayıt yapmayız.
      // Numara başka bir hesaptan TAŞINDIYSA (WABA değişti) Meta yeni hesapta
      // yeniden kayıt ister — numara o anda da "CLOUD_API" görünebilir, bu yüzden
      // yalnızca platform_type'a bakmak yetmez.
      const sameNumber = hotel.waPhoneNumberId === phoneNumberId
      const isReconnect = sameNumber && hotel.waBusinessId === wabaId && phone.platform_type === 'CLOUD_API'
      const pin = sameNumber && hotel.waRegistrationPin ? hotel.waRegistrationPin : newPin()
      let registered = false
      let registrationNote: string | null = null
      if (!isReconnect) {
        try {
          await registerPhone(token, phoneNumberId, pin)
          registered = true
        } catch (err) {
          const code = err instanceof MetaGraphError ? err.metaCode : undefined
          // Numara zaten kayıtlıysa ve hata PIN uyuşmazlığı ya da deneme sınırı
          // değilse, kayıt bu hesap için gerekmiyor olabilir: bağlantıyı kur,
          // panelde uyarı bırak. Kayıtlı değilse hata ölümcül.
          if (phone.platform_type === 'CLOUD_API' && code !== 133005 && code !== 133016) {
            registrationNote =
              'Numara Meta\'da zaten kayıtlı göründüğü için yeniden kaydedilemedi. Mesaj gönderiminde sorun olursa "Yeniden bağlan"ı deneyin.'
            this.app.log.warn({ hotelId, phoneNumberId, metaCode: code }, 'Numara zaten kayıtlı — yeniden kayıt başarısız, bağlantı sürdürülüyor')
          } else {
            throw err
          }
        }
      }

      // 6. Kaydet
      const updated = await this.app.prisma.hotel.update({
        where: { id: hotelId },
        data: {
          waBusinessId: wabaId,
          waPhoneNumberId: phoneNumberId,
          waAccessToken: token,
          // Kayıt yapıldıysa yeni PIN; yeniden bağlanmada mevcut PIN; aksi hâlde bilinmiyor
          waRegistrationPin: registered ? pin : sameNumber ? hotel.waRegistrationPin : null,
          waStatus: 'CONNECTED',
          waStatusMessage: registrationNote,
          waConnectedAt: new Date(),
          waDisplayPhone: phone.display_phone_number ?? null,
          waVerifiedName: phone.verified_name ?? null,
          waNameStatus: phone.name_status ?? null,
          waQualityRating: phone.quality_rating ?? null,
        },
        select: { id: true },
      })

      await this.writeAudit(hotelId, actorUserId, 'WA_CONNECTED', {
        wabaId,
        phoneNumberId,
        displayPhone: phone.display_phone_number,
        registered,
        movedFromAnotherAccount: !!hotel.waBusinessId && hotel.waBusinessId !== wabaId,
      })
      this.app.log.info({ hotelId, phoneNumberId, registered, isReconnect }, 'WhatsApp bağlandı')
      void updated
      return this.status(hotelId)
    } catch (err) {
      const userMessage =
        err instanceof MetaGraphError
          ? err.userMessage
          : (err as { statusCode?: number; message?: string }).statusCode
            ? (err as Error).message
            : 'Bağlantı sırasında beklenmeyen bir hata oluştu.'

      // Sadece durum mesajını güncelle: önceden çalışan bir bağlantı varsa
      // başarısız bir yeniden bağlanma denemesi onu BOZMAMALI.
      await this.app.prisma.hotel.update({
        where: { id: hotelId },
        data: { waStatusMessage: userMessage },
      }).catch(() => {})

      this.app.log.warn(
        {
          hotelId,
          step: err instanceof MetaGraphError ? err.step : undefined,
          metaCode: err instanceof MetaGraphError ? err.metaCode : undefined,
          reason: err instanceof MetaGraphError ? err.metaMessage : (err as Error).message,
        },
        'WhatsApp bağlantısı başarısız',
      )

      if (err instanceof MetaGraphError) {
        throw Object.assign(createError(err.httpStatus === 503 ? 503 : 400, userMessage), {
          code: `WA_${err.step.toUpperCase()}_FAILED`,
        })
      }
      throw err
    }
  }

  async disconnect(hotelId: string, actorUserId: string) {
    const hotel = await this.app.prisma.hotel.findUnique({
      where: { id: hotelId },
      select: { id: true, waBusinessId: true, waAccessToken: true, waStatus: true },
    })
    if (!hotel) throw createError(404, 'Otel bulunamadı')

    // Aboneliği kaldırmayı dene; olmazsa yine de StayLine tarafında bağlantıyı
    // keseriz (webhook DISCONNECTED otelin mesajlarını işlemez).
    let unsubscribed = false
    if (hotel.waBusinessId && hotel.waAccessToken) {
      try {
        await unsubscribeApp(hotel.waAccessToken, hotel.waBusinessId)
        unsubscribed = true
      } catch (err) {
        this.app.log.warn({ hotelId, reason: (err as Error).message }, 'Abonelik kaldırılamadı — StayLine tarafında yine de kesiliyor')
      }
    }

    await this.app.prisma.hotel.update({
      where: { id: hotelId },
      data: {
        waAccessToken: null,
        waStatus: 'DISCONNECTED',
        waStatusMessage: 'Bağlantı kesildi. Yeniden bağlanmak için "WhatsApp\'ı Bağla"yı kullanın.',
        // waPhoneNumberId / waBusinessId / PIN bilerek korunur: yeniden bağlanırken
        // aynı numara için aynı PIN gerekir; numara da başka otele kayamaz.
      },
    })
    await this.writeAudit(hotelId, actorUserId, 'WA_DISCONNECTED', { unsubscribed })
    return this.status(hotelId)
  }

  async status(hotelId: string, refreshFromMeta = false) {
    let hotel = await this.app.prisma.hotel.findUnique({
      where: { id: hotelId },
      select: {
        waStatus: true, waStatusMessage: true, waConnectedAt: true, waPhoneNumberId: true,
        waBusinessId: true, waDisplayPhone: true, waVerifiedName: true, waNameStatus: true,
        waQualityRating: true, waAccessToken: true,
      },
    })
    if (!hotel) throw createError(404, 'Otel bulunamadı')

    // Görünen ad onayı ve kalite puanı Meta tarafında değişir; istenirse tazele.
    if (refreshFromMeta && hotel.waStatus !== 'DISCONNECTED' && hotel.waAccessToken && hotel.waPhoneNumberId) {
      try {
        const p = await getPhoneNumber(hotel.waAccessToken, hotel.waPhoneNumberId)
        hotel = await this.app.prisma.hotel.update({
          where: { id: hotelId },
          data: {
            waDisplayPhone: p.display_phone_number ?? hotel.waDisplayPhone,
            waVerifiedName: p.verified_name ?? hotel.waVerifiedName,
            waNameStatus: p.name_status ?? hotel.waNameStatus,
            waQualityRating: p.quality_rating ?? hotel.waQualityRating,
          },
          select: {
            waStatus: true, waStatusMessage: true, waConnectedAt: true, waPhoneNumberId: true,
            waBusinessId: true, waDisplayPhone: true, waVerifiedName: true, waNameStatus: true,
            waQualityRating: true, waAccessToken: true,
          },
        })
      } catch (err) {
        this.app.log.warn({ hotelId, reason: (err as Error).message }, 'Numara durumu Meta\'dan alınamadı')
      }
    }

    // Token asla dışarı verilmez
    const { waAccessToken, ...safe } = hotel
    return { ...safe, hasToken: !!waAccessToken }
  }

  // ── Meta'nın hesap bildirimleri (webhook) ───────────────────
  // entry.id = WhatsApp hesap (WABA) kimliği
  async handleAccountEvent(wabaId: string, field: string, value: Record<string, unknown>) {
    const hotel = await this.app.prisma.hotel.findFirst({
      where: { waBusinessId: wabaId },
      select: { id: true, name: true },
    })
    if (!hotel) {
      this.app.log.warn({ wabaId, field }, 'Hesap bildirimi: bu WhatsApp hesabı hiçbir otele bağlı değil')
      return
    }
    const event = String(value.event ?? value.decision ?? '')

    if (field === 'account_update') {
      if (event === 'PARTNER_REMOVED') {
        // Otel, StayLine'ın erişimini Meta tarafında kaldırdı
        await this.app.prisma.hotel.update({
          where: { id: hotel.id },
          data: {
            waStatus: 'DISCONNECTED',
            waAccessToken: null,
            waStatusMessage: 'Otel, StayLine\'ın WhatsApp erişimini Meta üzerinden kaldırdı. Yeniden bağlanması gerekiyor.',
          },
        })
      } else if (['DISABLED_UPDATE', 'ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'ACCOUNT_DELETED'].includes(event)) {
        await this.app.prisma.hotel.update({
          where: { id: hotel.id },
          data: {
            waStatus: 'ERROR',
            waStatusMessage: `Meta hesap uyarısı: ${event}. WhatsApp Manager'dan hesabın durumunu kontrol edin.`,
          },
        })
      }
    } else if (field === 'phone_number_name_update') {
      const decision = String(value.decision ?? '')
      const requested = typeof value.requested_verified_name === 'string' ? value.requested_verified_name : undefined
      await this.app.prisma.hotel.update({
        where: { id: hotel.id },
        data: {
          waNameStatus: decision || null,
          ...(decision === 'APPROVED' && requested ? { waVerifiedName: requested } : {}),
          ...(decision === 'REJECTED' ? { waStatusMessage: 'Meta görünen adı reddetti. WhatsApp Manager\'dan yeni bir ad önerin.' } : {}),
        },
      })
    } else if (field === 'phone_number_quality_update') {
      if (['FLAGGED', 'DOWNGRADE'].includes(event)) {
        await this.app.prisma.hotel.update({
          where: { id: hotel.id },
          data: {
            waStatusMessage: `Meta kalite uyarısı: ${event} (mesaj limiti: ${String(value.current_limit ?? '-')}). Misafirlerden şikâyet geliyor olabilir.`,
          },
        })
      }
    }

    const alarming =
      (field === 'account_update' && ['PARTNER_REMOVED', 'DISABLED_UPDATE', 'ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'ACCOUNT_DELETED'].includes(event)) ||
      (field === 'phone_number_quality_update' && ['FLAGGED', 'DOWNGRADE'].includes(event)) ||
      (field === 'phone_number_name_update' && event === 'REJECTED')
    if (alarming) {
      raiseAlertInBackground(this.app, {
        key: `wa-account:${hotel.id}:${field}:${event}`,
        title: `WhatsApp hesap uyarısı: ${hotel.name}`,
        detail: `Meta "${field}" bildirimi gönderdi (${event}). Panelde otelin WhatsApp sayfasında ayrıntı var.`,
        hotelId: hotel.id,
        context: { alan: field, olay: event },
      })
    }

    await this.writeAudit(hotel.id, null, 'WA_ACCOUNT_EVENT', { field, event })
    this.app.log.info({ hotelId: hotel.id, field, event }, 'WhatsApp hesap bildirimi işlendi')
  }

  private async writeAudit(hotelId: string, userId: string | null, action: string, newValue: object) {
    await this.app.prisma.auditLog
      .create({ data: { hotelId, userId, action, entity: 'Hotel', entityId: hotelId, newValue } })
      .catch((err) => this.app.log.error({ err, action }, 'Denetim kaydı yazılamadı'))
  }
}
