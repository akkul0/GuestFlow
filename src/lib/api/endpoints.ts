import { apiFetch } from "./client";
import {
  normalizeMe,
  normalizeConversation,
  normalizeMessage,
  normalizeGuest,
  toItems,
} from "@/lib/normalize";
import type {
  Conversation,
  ConversationFilters,
  CreateStaffInput,
  CurrentUser,
  DailyReportRow,
  DailyToday,
  DailyComparison,
  DashboardStats,
  Department,
  Guest,
  GuestsPage,
  HotelUser,
  Message,
  MgbReport,
  OnShiftUser,
  OrderStatus,
  OrderTask,
  PhoneCoverage,
  Shift,
  ShiftAssignment,
  PlatformHotel,
  WhatsAppConnection,
} from "@/types/api";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const authApi = {
  me: async (): Promise<CurrentUser> =>
    normalizeMe(await apiFetch<unknown>("/auth/me")),
};

function buildConvQuery(f: ConversationFilters): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.search) p.set("search", f.search);
  if (f.unreadOnly) p.set("unreadOnly", "true");
  if (f.assignedTo) p.set("assignedTo", f.assignedTo);
  if (f.cursor) p.set("cursor", f.cursor);
  p.set("limit", String(f.limit ?? 30));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const chatApi = {
  list: async (f: ConversationFilters) => {
    const raw = await apiFetch<unknown>(`/chat/conversations${buildConvQuery(f)}`);
    return toItems<Conversation>(raw, normalizeConversation);
  },
  get: async (id: string): Promise<Conversation> =>
    normalizeConversation(await apiFetch<unknown>(`/chat/conversations/${id}`)),
  messages: async (id: string, cursor?: string) => {
    const q = new URLSearchParams({ limit: "50" });
    if (cursor) q.set("cursor", cursor);
    const raw = await apiFetch<unknown>(
      `/chat/conversations/${id}/messages?${q.toString()}`,
    );
    return toItems<Message>(raw, normalizeMessage);
  },
  send: async (
    id: string,
    payload: { body: string; clientMsgId?: string; autoTranslate?: boolean },
  ): Promise<Message> =>
    normalizeMessage(
      await apiFetch<unknown>(`/chat/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          body: payload.body,
          direction: "OUTBOUND",
          clientMsgId: payload.clientMsgId,
          autoTranslate: payload.autoTranslate,
        }),
      }),
    ),
  setStatus: (id: string, status: string) =>
    apiFetch(`/chat/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  setAi: (id: string, isAiEnabled: boolean) =>
    apiFetch(`/chat/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isAiEnabled }),
    }),
  markRead: (id: string) =>
    apiFetch(`/chat/conversations/${id}/read`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  startConversation: async (guestId: string): Promise<{ id: string }> =>
    apiFetch<{ id: string }>("/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ guestId }),
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/chat/conversations/${id}`, { method: "DELETE" }),
  correctText: (text: string): Promise<{ text: string }> =>
    apiFetch<{ text: string }>("/chat/correct-text", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  enrichText: (text: string): Promise<{ text: string }> =>
    apiFetch<{ text: string }>("/chat/enrich-text", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  getNotes: (id: string): Promise<{ notes: string }> =>
    apiFetch<{ notes: string }>(`/chat/conversations/${id}/notes`),
  saveNotes: (id: string, notes: string): Promise<{ notes: string }> =>
    apiFetch<{ notes: string }>(`/chat/conversations/${id}/notes`, {
      method: "PUT",
      body: JSON.stringify({ notes }),
    }),
  aiSuggest: async (id: string): Promise<string> => {
    const r = await apiFetch<any>(`/chat/conversations/${id}/ai-suggest`, {
      method: "POST",
    });
    return r?.suggestion ?? r?.text ?? r?.message ?? "";
  },
};

export const aiApi = {
  translate: async (text: string, targetLanguage: string): Promise<string> => {
    const r = await apiFetch<any>("/ai/translate", {
      method: "POST",
      body: JSON.stringify({ text, targetLanguage }),
    });
    return r?.translated ?? r?.text ?? text;
  },
};

export const dashboardApi = {
  stats: (range?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (range?.from) q.set("from", range.from);
    if (range?.to) q.set("to", range.to);
    const s = q.toString();
    return apiFetch<DashboardStats>(`/dashboard${s ? `?${s}` : ""}`);
  },
  phoneCoverage: () => apiFetch<PhoneCoverage>("/dashboard/phone-coverage"),
};

export const guestsApi = {
  list: async (params: {
    page?: number;
    limit?: number;
    search?: string;
    checkedIn?: boolean;
  }): Promise<GuestsPage> => {
    const q = new URLSearchParams();
    q.set("page", String(params.page ?? 1));
    q.set("limit", String(params.limit ?? 50));
    if (params.search) q.set("search", params.search);
    if (params.checkedIn) q.set("checkedIn", "true");
    const raw = await apiFetch<any>(`/guests?${q.toString()}`);
    return {
      items: (raw?.items ?? [])
        .map(normalizeGuest)
        .filter(Boolean) as Guest[],
      pagination: raw?.pagination ?? {
        page: 1,
        limit: params.limit ?? 50,
        total: 0,
        totalPages: 0,
      },
    };
  },
  create: async (body: {
    firstName: string;
    lastName: string;
    phone: string;
    language?: string;
    roomNumber?: string;
    nationality?: string;
    checkInDate?: string;
    checkOutDate?: string;
    agencyName?: string;
  }): Promise<Guest> => {
    const raw = await apiFetch<any>("/guests", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return normalizeGuest(raw) as Guest;
  },
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/guests/${id}`, { method: "DELETE" }),
};

/* ──────────────────────────── admin: departments ─────────────────────────── */
export const departmentsApi = {
  list: async (): Promise<Department[]> => {
    const raw = await apiFetch<any>("/orders/departments");
    return raw?.items ?? [];
  },
  create: (body: Partial<Department>): Promise<Department> =>
    apiFetch<Department>("/orders/departments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Department>): Promise<Department> =>
    apiFetch<Department>(`/orders/departments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/orders/departments/${id}`, { method: "DELETE" }),
};

/* ──────────────────────────── admin: shifts ──────────────────────────────── */
export const shiftsApi = {
  list: async (departmentId?: string): Promise<Shift[]> => {
    const q = departmentId ? `?departmentId=${departmentId}` : "";
    const raw = await apiFetch<any>(`/orders/shifts${q}`);
    return raw?.items ?? [];
  },
  create: (body: Partial<Shift>): Promise<Shift> =>
    apiFetch<Shift>("/orders/shifts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Shift>): Promise<Shift> =>
    apiFetch<Shift>(`/orders/shifts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/orders/shifts/${id}`, { method: "DELETE" }),
};

/* ─────────────────────── admin: shift assignments ────────────────────────── */
export const shiftAssignmentsApi = {
  list: async (params: {
    shiftId?: string;
    from?: string;
    to?: string;
    departmentId?: string;
    userId?: string;
  }): Promise<ShiftAssignment[]> => {
    const q = new URLSearchParams();
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    if (params.departmentId) q.set("departmentId", params.departmentId);
    if (params.userId) q.set("userId", params.userId);
    const s = q.toString();
    const raw = await apiFetch<any>(`/orders/shift-assignments${s ? `?${s}` : ""}`);
    const items: ShiftAssignment[] = raw?.items ?? [];
    // client-side scope to a single shift when requested (list endpoint has no shiftId filter)
    return params.shiftId
      ? items.filter((a) => a.shiftId === params.shiftId)
      : items;
  },
  onShift: async (departmentId: string, at?: string): Promise<OnShiftUser[]> => {
    const q = new URLSearchParams({ departmentId });
    if (at) q.set("at", at);
    const raw = await apiFetch<any>(`/orders/shift-assignments/on-shift?${q.toString()}`);
    return raw?.items ?? [];
  },
  assign: (body: {
    shiftId: string;
    userId: string;
    date: string;
  }): Promise<ShiftAssignment> =>
    apiFetch<ShiftAssignment>("/orders/shift-assignments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unassign: (id: string): Promise<void> =>
    apiFetch<void>(`/orders/shift-assignments/${id}`, { method: "DELETE" }),
  copyWeek: (body: {
    fromWeekStart: string;
    toWeekStart: string;
  }): Promise<{ copied: number }> =>
    apiFetch<{ copied: number }>("/orders/shift-assignments/copy-week", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/* ──────────────────────────── admin: staff ───────────────────────────────── */
export const staffApi = {
  list: async (hotelId: string): Promise<HotelUser[]> => {
    const raw = await apiFetch<any>(`/hotels/${hotelId}/users`);
    return raw?.items ?? [];
  },
  create: (hotelId: string, body: CreateStaffInput): Promise<HotelUser> =>
    apiFetch<HotelUser>(`/hotels/${hotelId}/users`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (
    hotelId: string,
    userId: string,
    body: Partial<HotelUser>,
  ): Promise<HotelUser> =>
    apiFetch<HotelUser>(`/hotels/${hotelId}/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (hotelId: string, userId: string): Promise<void> =>
    apiFetch<void>(`/hotels/${hotelId}/users/${userId}`, { method: "DELETE" }),
};

/* ──────────────────────────── order taker list ───────────────────────────── */
export const ordersApi = {
  list: async (params?: {
    status?: string;
    departmentId?: string;
  }): Promise<OrderTask[]> => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.departmentId) q.set("departmentId", params.departmentId);
    const s = q.toString();
    const raw = await apiFetch<any>(`/orders${s ? `?${s}` : ""}`);
    return raw?.items ?? [];
  },
  create: (body: {
    departmentId: string;
    requestText: string;
    roomNumber?: string;
    urgency?: string;
    note?: string;
  }): Promise<OrderTask> =>
    apiFetch<OrderTask>("/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: { status?: OrderStatus }): Promise<OrderTask> =>
    apiFetch<OrderTask>(`/orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/orders/${id}`, { method: "DELETE" }),
};

export const reportsApi = {
  // Günlük PDF raporunu şimdi maille (23:30 otomatiğiyle aynı kod)
  sendMailNow: (): Promise<{ ok: boolean; to: string }> =>
    apiFetch<{ ok: boolean; to: string }>(`/reports/send-mail-now`, { method: "POST" }),

  daily: async (): Promise<DailyReportRow[]> => {
    const raw = await apiFetch<any>(`/reports/daily`);
    return raw?.items ?? [];
  },
  today: (): Promise<DailyToday> => apiFetch<DailyToday>(`/reports/daily/today`),
  comparison: (): Promise<DailyComparison> =>
    apiFetch<DailyComparison>(`/reports/comparison`),
  mgb: (period: string = "7d"): Promise<MgbReport> =>
    apiFetch<MgbReport>(`/reports/mgb?period=${period}`),
};


// ── Google Yorum Analizi ──────────────────────────────────
export interface ReviewItem {
  author: string;
  rating: number;
  text: string;
  translation: string | null;
  sentiment: "praise" | "complaint" | "neutral";
  severity: number;
  department: string;
  date: string;
}
export interface ReviewAnalysis {
  place: { name: string; rating: number; totalReviews: number };
  last24h: {
    total: number;
    praise: number;
    complaints: number;
    byDepartment: Record<string, number>;
    bySeverity: { high: number; medium: number; low: number };
  };
  reviews: ReviewItem[];
}

export const reviewsApi = {
  analyze: (): Promise<ReviewAnalysis> =>
    apiFetch<ReviewAnalysis>("/reviews/analyze", { method: "POST" }),
};


// ── WhatsApp Şablon Mesajları (24 saat penceresi kapalıyken tek yol) ──
export interface MetaTemplate {
  name: string;
  language: string;
  category: string | null;
  bodyText: string;
  variableCount: number;
  headerText: string | null;
  footerText: string | null;
}

export interface HotelSettings {
  id: string;
  name: string;
  autoWelcomeEnabled?: boolean;
  welcomeTemplateName?: string | null;
  welcomeTemplateLang?: string | null;
  waPhoneNumberId?: string | null;
}

export const hotelSettingsApi = {
  get: (hotelId: string): Promise<HotelSettings> =>
    apiFetch<HotelSettings>(`/hotels/${hotelId}/settings`),
  patch: (
    hotelId: string,
    body: {
      autoWelcomeEnabled?: boolean;
      welcomeTemplateName?: string | null;
      welcomeTemplateLang?: string;
    },
  ): Promise<HotelSettings> =>
    apiFetch<HotelSettings>(`/hotels/${hotelId}/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

export interface BulkTemplateResult {
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  errors: string[];
}

export const bulkTemplateApi = {
  send: (body: {
    templateName: string;
    lang: string;
    target: "staying" | "selected";
    guestIds?: string[];
  }): Promise<BulkTemplateResult> =>
    apiFetch<BulkTemplateResult>("/whatsapp/bulk-template", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const templatesApi = {
  // Meta'daki ONAYLI şablonları canlı çeker
  listApproved: (): Promise<{ items: MetaTemplate[] }> =>
    apiFetch<{ items: MetaTemplate[] }>("/whatsapp/meta-templates"),

  // Şablonu misafire gönderir (konuşmayı başlatır)
  send: (
    conversationId: string,
    payload: { templateName: string; language: string; variables: string[]; preview: string },
  ): Promise<unknown> =>
    apiFetch(`/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        // body: panelde görünecek okunabilir metin (değişkenler yerleşmiş hali)
        body: payload.preview,
        contentType: "TEMPLATE",
        templateName: payload.templateName,
        templateData: { language: payload.language, variables: payload.variables },
      }),
    }),
};

/* ──────────────────────────── platform (SUPER_ADMIN) ─────────────────────────── */
export const platformApi = {
  hotels: async (): Promise<PlatformHotel[]> => {
    const raw = await apiFetch<{ items?: PlatformHotel[] }>("/hotels");
    return raw?.items ?? [];
  },
  create: (body: {
    name: string;
    slug: string;
    address?: string;
    admin: { firstName: string; lastName: string; username: string; password: string; email?: string };
  }) =>
    apiFetch<{ hotel: { id: string; name: string; slug: string }; admin: { id: string; username: string }; loginUrl: string }>(
      "/hotels",
      { method: "POST", body: JSON.stringify(body) },
    ),
  update: (id: string, body: { name?: string; slug?: string; isActive?: boolean; logoUrl?: string | null }) =>
    apiFetch<PlatformHotel>(`/hotels/${id}/platform`, { method: "PATCH", body: JSON.stringify(body) }),
  /** Oteli ve bütün verisini kalıcı olarak siler. Otel önce kapatılmış olmalı. */
  remove: (id: string, confirmSlug: string) =>
    apiFetch<{ deleted: boolean; users: number; guests: number; conversations: number; orders: number }>(
      `/hotels/${id}/delete`,
      { method: "POST", body: JSON.stringify({ confirmSlug }) },
    ),
  /** Oturumu seçilen otele taşır (BFF yeni çerezleri yazar). */
  switchHotel: (hotelId: string) =>
    apiFetch<unknown>("/auth/switch-hotel", { method: "POST", body: JSON.stringify({ hotelId }) }),
};

/* ──────────────────────────── WhatsApp bağlantısı ─────────────────────────── */
export const onboardingApi = {
  status: (refresh = false) =>
    apiFetch<WhatsAppConnection>(`/onboarding/whatsapp/status${refresh ? "?refresh=1" : ""}`),
  /** phoneNumberId yoksa yalnızca hesap bağlanır (numara taşıma akışının ilk adımı). */
  connect: (body: { code: string; wabaId: string; phoneNumberId?: string }) =>
    apiFetch<WhatsAppConnection>("/onboarding/whatsapp", { method: "POST", body: JSON.stringify(body) }),
  migrateStart: (body: { countryCode: string; phoneNumber: string; method: "SMS" | "VOICE" }) =>
    apiFetch<WhatsAppConnection>("/onboarding/whatsapp/migrate/start", { method: "POST", body: JSON.stringify(body) }),
  migrateResend: (method: "SMS" | "VOICE") =>
    apiFetch<WhatsAppConnection>("/onboarding/whatsapp/migrate/resend", { method: "POST", body: JSON.stringify({ method }) }),
  migrateVerify: (code: string) =>
    apiFetch<WhatsAppConnection>("/onboarding/whatsapp/migrate/verify", { method: "POST", body: JSON.stringify({ code }) }),
  disconnect: () =>
    apiFetch<WhatsAppConnection>("/onboarding/whatsapp/disconnect", { method: "POST" }),
};
