/**
 * Shared API types for the GuestFlow frontend.
 *
 * Hand-written from the backend Prisma schema + the API's normalized response
 * shapes. (Later these can be generated from the backend's @fastify/swagger
 * JSON via openapi-typescript — see plan "Deferred".)
 */

// ---- enums ----
export type Role = "SUPER_ADMIN" | "HOTEL_ADMIN" | "MANAGER" | "ORDER_TAKER" | "AGENT";

export type ConversationStatus = "OPEN" | "PENDING" | "RESOLVED" | "ARCHIVED";

export type MessageDirection = "INBOUND" | "OUTBOUND";

export type MessageStatus = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";

export type ContentType =
  | "TEXT"
  | "IMAGE"
  | "DOCUMENT"
  | "AUDIO"
  | "VIDEO"
  | "TEMPLATE"
  | "INTERACTIVE"
  | "LOCATION"
  | "STICKER";

// ---- auth ----
export interface CurrentUser {
  id: string;
  username: string;
  email?: string | null;
  firstName: string;
  lastName: string;
  role: Role;
  language: string;
  hotelId: string;
  hotelName: string;
  aiEnabled: boolean;
  autoTranslate: boolean;
  /** ORDER_TAKER (departman şefi) için bağlı olduğu departman */
  departmentId?: string | null;
  departmentName?: string | null;
  /** Sohbet / misafir / yorum bölümlerini görebilir mi (şef değilse daima true) */
  guestAccess?: boolean;
  /** Oturumdaki otelin kısa adı (giriş adresi: admin.stayline.net/<kısa-ad>) */
  hotelSlug: string;
  /** SUPER_ADMIN: bütün otelleri yönetir, oteller arasında geçebilir */
  isPlatformAdmin: boolean;
  /** Platform yöneticisi kendi kayıtlı oteli dışında bir oteldeyken true */
  actingInOtherHotel: boolean;
  /** İlk girişte (ya da şifre sıfırlandıktan sonra) şifre değiştirmesi gerekiyor */
  mustChangePassword: boolean;
}

export interface LoginResponse {
  expiresIn: number;
  mustChangePassword?: boolean;
  user: CurrentUser;
}

// ---- platform (SUPER_ADMIN) ----
export interface PlatformHotel {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  whatsappConnected: boolean;
  userCount: number;
  guestCount: number;
  loginUrl: string;
  logoUrl: string | null;
}

// ---- WhatsApp bağlantısı ----
export type WaStatus = "DISCONNECTED" | "CONNECTED" | "ERROR" | "PENDING_NUMBER";

export interface WhatsAppConnection {
  waStatus: WaStatus;
  waStatusMessage: string | null;
  waConnectedAt: string | null;
  waPhoneNumberId: string | null;
  waBusinessId: string | null;
  waDisplayPhone: string | null;
  waVerifiedName: string | null;
  waNameStatus: string | null;
  waQualityRating: string | null;
  hasToken: boolean;
}

// ---- guests ----
export interface RoomRef {
  id?: string;
  number: string;
  floor?: number | null;
  type?: string | null;
}

export interface Companion {
  id: string;
  firstName: string;
  lastName: string;
  birthDate?: string | null;
}

export interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  nationality?: string | null;
  language?: string | null;
  birthDate?: string | null;
  agencyName?: string | null;
  bookingSource?: string | null;
  isVip: boolean;
  notes?: string | null;
  room?: RoomRef | null;
  roomNumber?: string | null;
  checkInDate?: string | null;
  checkOutDate?: string | null;
  reservationNo?: string | null;
  companions?: Companion[];
}

// ---- chat ----
export interface AgentRef {
  id: string;
  firstName: string;
  lastName: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  contentType: ContentType;
  body?: string | null;
  bodyOriginal?: string | null;
  translatedFrom?: string | null;
  mediaUrl?: string | null;
  status: MessageStatus;
  isAiGenerated: boolean;
  sentById?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  createdAt: string;
  /** client-generated id for optimistic-send reconciliation */
  clientMsgId?: string;
}

export interface Conversation {
  id: string;
  status: ConversationStatus;
  waContactId: string;
  displayName: string;
  language?: string | null;
  unreadCount: number;
  isAiEnabled: boolean;
  lastMessageAt?: string | null;
  guest?: Guest | null;
  agent?: AgentRef | null;
  /** last message preview (list endpoint returns the latest one) */
  messages?: Message[];
  lastMessage?: Message | null;
  /** mesaj içeriği aramasında eşleşen metin (arama yapıldıysa dolu) */
  matchedMessage?: string | null;
}

export interface Paginated<T> {
  items: T[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

export interface ConversationFilters {
  status?: ConversationStatus;
  search?: string;
  unreadOnly?: boolean;
  assignedTo?: string;
  cursor?: string;
  limit?: number;
}

// ---- dashboard ----
export interface RoomStats {
  totalRooms: number;
  checkinRooms: number;
  phoneRooms: number;
  noPhoneRooms: number;
  reachedRooms: number;
  unreachedRooms: number;
  reachRate: number;
}

export interface MessageStats {
  sent: number;
  delivered: number;
  failed: number;
  received: number;
  aiGenerated: number;
  deliveryRate: number;
}

export interface TemplateBreakdownRow {
  template: string;
  count: number;
  percent: number;
}

export interface FailureReasonRow {
  reason: string;
  count: number;
  percent: number;
}

export interface MonthlyTrendPoint {
  month: string;
  sent: number;
  delivered: number;
  failed: number;
}

export interface DashboardDeptRow {
  key: string;
  label: string;
  count: number;
}

export interface DashboardRecentOrder {
  id: string;
  room: string;
  text: string;
  urgency: "LOW" | "MEDIUM" | "HIGH";
  isComplaint: boolean;
  isRequest: boolean;
  department: string;
  createdAt: string;
}

export interface DashboardStats {
  period?: { from: string; to: string };
  rooms: RoomStats;
  messages: MessageStats;
  failureReasons: FailureReasonRow[];
  unmatchedGuests: number;
  departmentBreakdown: DashboardDeptRow[];
  recentOrders: DashboardRecentOrder[];
  openRequests: number;
  todayComplaints: number;
}

export interface PhoneCoverage {
  total: number;
  withPhone: number;
  withoutPhone: number;
  coveragePercent: number;
}

export interface GuestsPage {
  items: Guest[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface DailyReportRow {
  id?: string;
  date: string;
  messagesSent?: number;
  messagesDelivered?: number;
  messagesReceived?: number;
  aiMessagesGenerated?: number;
  newGuests?: number;
}

export interface DailyToday extends DailyReportRow {
  openRequests?: number;
  complaints?: number;
}

export interface RangeMetrics {
  sent: number;
  received: number;
  totalMessages: number;
  aiGenerated: number;
  aiRatePct: number;
  requests: number;
  complaints: number;
  guestsReached: number;
}

export interface DailyComparison {
  today: RangeMetrics;
  last3: RangeMetrics;
  last7: RangeMetrics;
}

// ---- admin: departments / shifts / staff / orders ----
// Departman key'i artik dinamik (manuel departmanlar serbest key alabilir).
// Bilinen hazir key'ler ipucu olarak listelenir ama herhangi bir string olabilir.
export type DepartmentKey =
  | "FRONT_DESK"
  | "HOUSEKEEPING"
  | "TECHNICAL"
  | "FB"
  | "SECURITY"
  | "MANAGEMENT"
  | "OTHER"
  | (string & {});

export interface Department {
  id: string;
  key: DepartmentKey;
  name: string;
  keywords?: string | null;
  isActive: boolean;
  isCustom?: boolean;
  /** Bu departmanın şefi sohbet/misafir/yorum bölümlerini görebilir mi */
  guestAccess?: boolean;
}

export interface Shift {
  id: string;
  departmentId: string;
  name: string;
  /** minutes from local midnight (0..1439); endMinutes <= startMinutes ⇒ overnight */
  startMinutes: number;
  endMinutes: number;
  isActive: boolean;
}

export interface ShiftUserRef {
  id: string;
  firstName: string;
  lastName: string;
}

export type ShiftAssignmentStatus = "SCHEDULED" | "OFF";

export interface ShiftAssignment {
  id: string;
  shiftId: string;
  departmentId: string;
  userId: string;
  /** ISO date (the local calendar day the shift starts on) */
  date: string;
  status: ShiftAssignmentStatus;
  user?: ShiftUserRef;
  shift?: { id: string; name: string; startMinutes: number; endMinutes: number };
}

export interface OnShiftUser {
  id: string;
  firstName: string;
  lastName: string;
  whatsappPhone?: string | null;
}

export interface HotelUser {
  id: string;
  username: string;
  email?: string | null;
  firstName: string;
  lastName: string;
  role: Role;
  isActive: boolean;
  whatsappPhone?: string | null;
  departmentId?: string | null;
}

export type OrderStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "DONE"
  | "CANCELLED";

export type OrderUrgency = "LOW" | "MEDIUM" | "HIGH";

export interface OrderTask {
  id: string;
  departmentId?: string | null;
  departmentKey: DepartmentKey;
  category: string;
  urgency: OrderUrgency;
  requestText: string;
  roomNumber?: string | null;
  status: OrderStatus;
  createdAt: string;
  /** SLA takibi: ilk dokunuş, kapanış ve eskalasyon zamanları */
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  escalatedAt?: string | null;
  department?: { id: string; name: string; key: DepartmentKey } | null;
  guest?: { id: string; firstName: string; lastName: string } | null;
}

// ---- MGB report ----
export interface MgbReport {
  summary: {
    occupancyPct: number;
    guestsReached: number;
    totalMessages: number;
    aiRatePct: number;
    failed: number;
  };
  departments: { key: string; label: string; value: number }[];
  nationalities: { label: string; value: number; count?: number }[];
  topRooms: { room: string; msgs: number }[];
  complaints: { id: string; room: string; text: string; urgency: string }[];
}

// ---- staff create ----
export interface CreateStaffInput {
  username: string;
  email?: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
  whatsappPhone?: string | null;
  departmentId?: string | null;
}

// ---- standard error envelope ----
export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string };
}
