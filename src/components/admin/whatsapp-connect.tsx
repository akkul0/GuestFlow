"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { WhatsappLogoIcon, ArrowClockwiseIcon, PlugsIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useWhatsAppActions, useWhatsAppConnection } from "@/hooks/use-whatsapp";
import { ApiError } from "@/lib/api/client";

// Meta Embedded Signup v4 — standart bağlantı (Coexistence yok).
// Değerler gizli değil; panel ortam değişkenlerinden gelir.
const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID ?? "";
const CONFIG_ID = process.env.NEXT_PUBLIC_META_ESU_CONFIG_ID ?? "";
const GRAPH_VERSION = process.env.NEXT_PUBLIC_META_GRAPH_VERSION ?? "v25.0";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<void> | null = null;
const SDK_RELOAD_FLAG = "wa-sdk-reload";

/** Facebook JavaScript SDK'yı bir kez yükler (yalnızca bu sayfada). */
function loadFacebookSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.FB) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("sdk"));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

type Phase = "idle" | "popup" | "saving";

export function WhatsAppConnect() {
  const t = useTranslations("whatsapp");
  const { data: conn, isLoading } = useWhatsAppConnection();
  const { connect, disconnect, refresh } = useWhatsAppActions();
  // "migrate": pencere numara adımını atlar (only_waba_sharing); numara sonra taşınır
  const modeRef = useRef<"standard" | "migrate">("standard");

  const [phase, setPhase] = useState<Phase>("idle");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);

  // Meta iki ayrı kanaldan veri gönderir ve sıraları belli değildir:
  //  • FB.login geri çağrısı → takas kodu (30 sn geçerli)
  //  • pencereden "message" olayı → WhatsApp hesap ve numara kimlikleri
  // İkisi de gelince backend'e tek istekte gönderiyoruz.
  const codeRef = useRef<string | null>(null);
  const assetsRef = useRef<{ wabaId: string; phoneNumberId?: string } | null>(null);
  const submittedRef = useRef(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const configured = !!APP_ID && !!CONFIG_ID;

  useEffect(() => {
    if (!configured) return;
    loadFacebookSdk()
      .then(() => {
        sessionStorage.removeItem(SDK_RELOAD_FLAG);
        setSdkReady(true);
      })
      .catch(() => {
        // Güvenlik politikası (CSP) sayfa ilk yüklendiğinde belirlenir. Panel
        // içinden bu sayfaya geçildiyse önceki sayfanın sıkı politikası geçerli
        // kalır ve SDK engellenir. Bir kez tam yükleme yap: bu sayfanın kendi
        // politikası Facebook'a izin verir. (Bayrak döngüye girmeyi önler.)
        if (!sessionStorage.getItem(SDK_RELOAD_FLAG)) {
          sessionStorage.setItem(SDK_RELOAD_FLAG, "1");
          window.location.reload();
          return;
        }
        sessionStorage.removeItem(SDK_RELOAD_FLAG);
        setFlowError(t("sdk_failed"));
      });
  }, [configured, t]);

  const resetFlow = useCallback(() => {
    codeRef.current = null;
    assetsRef.current = null;
    submittedRef.current = false;
    if (waitTimer.current) clearTimeout(waitTimer.current);
    waitTimer.current = null;
  }, []);

  const trySubmit = useCallback(() => {
    const code = codeRef.current;
    const assets = assetsRef.current;
    if (!code || !assets || submittedRef.current) return;
    submittedRef.current = true;
    if (waitTimer.current) clearTimeout(waitTimer.current);
    setPhase("saving");
    connect.mutate(
      { code, wabaId: assets.wabaId, ...(assets.phoneNumberId ? { phoneNumberId: assets.phoneNumberId } : {}) },
      {
        onSuccess: () => {
          toast.success(t("connected_toast"));
          setFlowError(null);
          setPhase("idle");
          resetFlow();
        },
        onError: (e) => {
          setFlowError(e instanceof ApiError ? e.message : t("connect_failed"));
          setPhase("idle");
          resetFlow();
        },
      },
    );
  }, [connect, resetFlow, t]);

  // Meta penceresinden gelen oturum bilgisi
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!event.origin.endsWith("facebook.com")) return;
      let data: any;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;

      const ev: string = data.event ?? "";
      if (ev.startsWith("FINISH")) {
        const wabaId = data.data?.waba_id;
        const phoneNumberId = data.data?.phone_number_id;
        // Taşıma kipinde pencere numarasız biter (FINISH_ONLY_WABA): yalnızca hesap bağlanır
        if (modeRef.current === "migrate" && wabaId && !phoneNumberId) {
          assetsRef.current = { wabaId: String(wabaId) };
          trySubmit();
          return;
        }
        if (!phoneNumberId) {
          setFlowError(t("no_phone_selected"));
          setPhase("idle");
          resetFlow();
          return;
        }
        assetsRef.current = { wabaId: String(wabaId), phoneNumberId: String(phoneNumberId) };
        trySubmit();
      } else if (ev === "CANCEL") {
        const d = data.data ?? {};
        setFlowError(
          d.error_message
            ? t("meta_error", { message: d.error_message, session: d.session_id ?? "-" })
            : t("cancelled", { step: d.current_step ?? "-" }),
        );
        setPhase("idle");
        resetFlow();
      } else if (ev === "ERROR") {
        setFlowError(t("meta_error", { message: data.data?.error_message ?? "-", session: data.data?.session_id ?? "-" }));
        setPhase("idle");
        resetFlow();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [resetFlow, t, trySubmit]);

  function launch(mode: "standard" | "migrate" = "standard") {
    modeRef.current = mode;
    if (!window.FB) return setFlowError(t("sdk_failed"));
    resetFlow();
    setFlowError(null);
    setPhase("popup");
    window.FB.login(
      (response: any) => {
        const code = response?.authResponse?.code;
        if (!code) {
          // Pencere kapatıldı ya da izin verilmedi. Oturum bilgisi CANCEL olarak
          // ayrıca gelebilir; o daha ayrıntılı mesajı gösterir.
          if (!assetsRef.current) {
            setPhase("idle");
            setFlowError((prev) => prev ?? t("cancelled_generic"));
          }
          return;
        }
        codeRef.current = code;
        trySubmit();
        // Kod geldi ama hesap bilgisi gelmediyse: genelde izinli alan adı ayarı eksiktir.
        if (!assetsRef.current) {
          waitTimer.current = setTimeout(() => {
            if (!submittedRef.current) {
              setFlowError(t("no_session_info"));
              setPhase("idle");
              resetFlow();
            }
          }, 10_000);
        }
      },
      {
        config_id: CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        // Taşıma: numara ekranları atlanır, numara panelden taşınır (Meta: only_waba_sharing)
        extras: mode === "migrate" ? { setup: {}, featureType: "only_waba_sharing" } : { setup: {} },
      },
    );
  }

  if (!configured) {
    return (
      <section className="rounded-xl border border-border-subtle bg-surface-1 p-5 text-[13px] text-text-body">
        <p className="flex items-center gap-2 font-medium text-err">
          <WarningIcon className="size-4" aria-hidden />
          {t("not_configured")}
        </p>
        <p className="mt-1 text-text-dim">{t("not_configured_desc")}</p>
      </section>
    );
  }

  const status = conn?.waStatus ?? "DISCONNECTED";
  const busy = phase !== "idle" || connect.isPending || disconnect.isPending;

  return (
    <div className="max-w-2xl space-y-5">
      <section className="rounded-xl border border-border-subtle bg-surface-1 p-5">
        <div className="flex items-start gap-3">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
              status === "CONNECTED" ? "bg-[rgba(52,211,153,.12)] text-[#34d399]" : status === "ERROR" ? "bg-[rgba(255,107,129,.12)] text-err" : "bg-surface-2 text-text-dim"
            }`}
          >
            <WhatsappLogoIcon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-text-strong">
              {isLoading ? t("loading") : t(`status_${status}`)}
            </p>
            {conn?.waDisplayPhone ? (
              <p className="mt-0.5 text-[13px] text-text-body">
                {conn.waDisplayPhone}
                {conn.waVerifiedName ? ` · ${conn.waVerifiedName}` : ""}
              </p>
            ) : null}
            {status === "CONNECTED" ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <dt className="text-text-dim">{t("name_status")}</dt>
                <dd className="text-text-body">{conn?.waNameStatus ?? "-"}</dd>
                <dt className="text-text-dim">{t("quality")}</dt>
                <dd className="text-text-body">{conn?.waQualityRating ?? "-"}</dd>
                <dt className="text-text-dim">{t("connected_at")}</dt>
                <dd className="text-text-body">
                  {conn?.waConnectedAt ? new Date(conn.waConnectedAt).toLocaleString("tr-TR") : "-"}
                </dd>
              </dl>
            ) : null}
          </div>
        </div>

        {conn?.waStatusMessage ? (
          <p className={`mt-4 rounded-md px-3 py-2 text-[12.5px] ${status === "CONNECTED" ? "bg-[rgba(245,158,11,.10)] text-[#f5b84b]" : "bg-[rgba(255,107,129,.08)] text-err"}`}>
            {conn.waStatusMessage}
          </p>
        ) : null}
        {flowError ? (
          <p role="alert" className="mt-4 rounded-md bg-[rgba(255,107,129,.08)] px-3 py-2 text-[12.5px] text-err">
            {flowError}
          </p>
        ) : null}
        {phase === "popup" ? <p className="mt-4 text-[12.5px] text-text-body">{t("popup_open")}</p> : null}
        {phase === "saving" ? <p className="mt-4 text-[12.5px] text-text-body">{t("saving")}</p> : null}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-4">
          {status === "CONNECTED" ? (
            <>
              <Button size="sm" variant="outline" disabled={busy || refresh.isPending} onClick={() => refresh.mutate()} className="gap-1.5">
                <ArrowClockwiseIcon className="size-4" aria-hidden />
                {t("refresh")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy || !sdkReady} onClick={() => launch()}>
                {t("reconnect")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                className="gap-1.5"
                onClick={() => {
                  if (window.confirm(t("disconnect_confirm"))) {
                    disconnect.mutate(undefined, {
                      onSuccess: () => toast.success(t("disconnected_toast")),
                      onError: (e) => toast.error(e instanceof Error ? e.message : t("connect_failed")),
                    });
                  }
                }}
              >
                <PlugsIcon className="size-4" aria-hidden />
                {t("disconnect")}
              </Button>
            </>
          ) : status === "PENDING_NUMBER" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("migrate_cancel_confirm"))) disconnect.mutate();
              }}
            >
              {t("migrate_cancel")}
            </Button>
          ) : (
            <div className="flex w-full flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !sdkReady} onClick={() => launch()} className="gap-1.5 bg-[#1877f2] text-white hover:bg-[#1877f2]/90">
                  <WhatsappLogoIcon className="size-4" aria-hidden />
                  {status === "DISCONNECTED" && conn?.waPhoneNumberId ? t("reconnect") : t("connect")}
                </Button>
                <Button variant="outline" disabled={busy || !sdkReady} onClick={() => launch("migrate")}>
                  {t("migrate_launch")}
                </Button>
              </div>
              <p className="text-[11.5px] text-text-dim">{t("migrate_hint")}</p>
            </div>
          )}
        </div>
      </section>

      {status === "PENDING_NUMBER" ? <MigrationSteps hasNumber={!!conn?.waPhoneNumberId} displayPhone={conn?.waDisplayPhone ?? null} /> : null}

      <section className="rounded-xl border border-border-subtle bg-surface-1 p-5 text-[12.5px] text-text-body">
        <p className="mb-2 font-medium text-text-strong">{t("before_title")}</p>
        <ul className="list-disc space-y-1.5 ps-5">
          <li>{t("before_1")}</li>
          <li>{t("before_2")}</li>
          <li>{t("before_3")}</li>
          <li>{t("before_4")}</li>
        </ul>
      </section>
    </div>
  );
}

/**
 * Başka bir sağlayıcıdan numara taşıma: hesap bağlandıktan sonra
 *  1) numara girilir → StayLine taşımayı başlatır, Meta kod gönderir
 *  2) kod girilir → doğrulama + kayıt → bağlı
 * Eski sağlayıcı 2. adımın sonuna kadar çalışmaya devam eder.
 */
function MigrationSteps({ hasNumber, displayPhone }: { hasNumber: boolean; displayPhone: string | null }) {
  const t = useTranslations("whatsapp");
  const { migrateStart, migrateResend, migrateVerify } = useWhatsAppActions();
  const [countryCode, setCountryCode] = useState("90");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<"SMS" | "VOICE">("SMS");
  const [code, setCode] = useState("");
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t("connect_failed"));
  const inputCls = "h-9 rounded-md border border-border-subtle bg-surface-2 px-3 text-[13px] text-text-strong";

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-1 p-5 text-[13px]">
      <p className="font-semibold text-text-strong">{t("migrate_title")}</p>
      <ol className="mt-2 list-decimal space-y-1 ps-5 text-[12px] text-text-body">
        <li>{t("migrate_req_1")}</li>
        <li>{t("migrate_req_2")}</li>
        <li>{t("migrate_req_3")}</li>
      </ol>

      {!hasNumber ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            migrateStart.mutate({ countryCode, phoneNumber: phone, method }, { onError });
          }}
        >
          <div className="flex gap-2">
            <label className="flex items-center gap-1">
              <span className="text-text-dim">+</span>
              <input aria-label={t("migrate_cc")} value={countryCode} onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ""))} className={`${inputCls} w-16`} />
            </label>
            <input
              aria-label={t("migrate_number")}
              placeholder="532 123 45 67"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={`${inputCls} flex-1`}
              inputMode="tel"
            />
          </div>
          <div className="flex gap-4 text-[12px] text-text-body">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={method === "SMS"} onChange={() => setMethod("SMS")} /> {t("migrate_sms")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={method === "VOICE"} onChange={() => setMethod("VOICE")} /> {t("migrate_voice")}
            </label>
          </div>
          <Button type="submit" size="sm" disabled={!countryCode || phone.replace(/\D/g, "").length < 6 || migrateStart.isPending}>
            {migrateStart.isPending ? t("saving") : t("migrate_start")}
          </Button>
        </form>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            migrateVerify.mutate(code, { onError, onSuccess: () => toast.success(t("connected_toast")) });
          }}
        >
          <p className="text-[12px] text-text-body">{t("migrate_code_sent", { phone: displayPhone ?? "-" })}</p>
          <input
            aria-label={t("migrate_code")}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${inputCls} w-40 text-center font-mono tracking-[0.3em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={code.replace(/\D/g, "").length !== 6 || migrateVerify.isPending}>
              {migrateVerify.isPending ? t("saving") : t("migrate_verify")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={migrateResend.isPending} onClick={() => migrateResend.mutate("SMS", { onError })}>
              {t("migrate_resend_sms")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={migrateResend.isPending} onClick={() => migrateResend.mutate("VOICE", { onError })}>
              {t("migrate_resend_voice")}
            </Button>
          </div>
          <p className="text-[11.5px] text-text-dim">{t("migrate_final_note")}</p>
        </form>
      )}
    </section>
  );
}
