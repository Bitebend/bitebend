export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: "super_admin" | "owner" | "partner";
  restaurantId: number | null;
}

export interface PartnerProfile {
  id: number;
  userId: number;
  name: string;
  email: string;
  phone: string;
  referralCode: string;
  commissionPercentage: number;
  status: "active" | "suspended";
  payoutDetails?: {
    upiId?: string | null;
    accountName?: string | null;
    accountNumber?: string | null;
    ifsc?: string | null;
    bankName?: string | null;
    updatedAt?: string;
  } | null;
  createdAt: string;
  updatedAt?: string;
  totalRestaurants?: number;
  totalEarned?: number;
  totalPending?: number;
  totalApproved?: number;
  totalPaid?: number;
}

export interface PartnerCommission {
  id: number;
  partnerId: number;
  partnerName?: string;
  partnerEmail?: string;
  partnerReferralCode?: string;
  partnerPayoutDetails?: any;
  restaurantId: number;
  restaurantName?: string;
  restaurantCity?: string;
  subscriptionTransactionId: number;
  transactionAmount: number;
  commissionRate: number;
  commissionAmount: number;
  currency: string;
  status: "pending" | "approved" | "paid" | "cancelled";
  payoutReference?: string | null;
  paidAt?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface PartnerDashboardData {
  partner: PartnerProfile;
  metrics: {
    totalRestaurants: number;
    activeRestaurants: number;
    totalEarned: number;
    pendingPayout: number;
    approvedPayout: number;
    paidPayout: number;
  };
  recentRestaurants: Array<{
    id: number;
    name: string;
    slug: string;
    phone: string;
    email: string;
    city: string;
    subscriptionStatus: string;
    subscriptionPlan: string;
    planId: number | null;
    isActive: boolean;
    createdAt: string;
  }>;
  recentCommissions: PartnerCommission[];
}

export interface SubscriptionPlan {
  id: number;
  name: string;
  price: number;
  customerLimit: number;
  description: string | null;
  isActive: boolean;
  displayOrder: number;
  validityType: "days" | "months";
  validityValue: number;
}

export interface SubscriptionTransaction {
  id: number;
  restaurantId: number;
  planId: number;
  amount: number;
  paymentMethod: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  status: "pending" | "paid" | "failed";
  customersAdded: number;
  createdAt: string;
  planName?: string;
  restaurantName?: string | null;
  restaurantState?: string | null;
  restaurantDistrict?: string | null;
}

export interface Notification {
  id: number;
  restaurantId: number | null;
  title: string;
  message: string;
  type: "info" | "warning" | "success" | "error";
  isRead: boolean;
  createdAt: string;
}

export interface Restaurant {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  cuisineType: string;
  logoUrl: string | null;
  address: string;
  city: string;
  state: string | null;
  district: string | null;
  phone: string;
  email: string;
  ownerId: number | null;
  isActive: boolean;
  upiId: string | null;
  upiName: string | null;
  personalUpiEnabled: boolean;
  upiVerified: boolean;
  verifiedAt: string | null;
  qrImageData: string | null;
  qrDecodedPayload: string | null;
  qrMerchantName: string | null;
  qrExtractedUpiId: string | null;
  paymentQrEnabled: boolean;
  whatsappNumber: string | null;
  /** @deprecated — restaurant Razorpay removed. Column retained for historical data only. */
  razorpayKeyId?: string | null;
  taxPercent: number;
  seatingLabel: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
  approvalNote: string | null;
  planId: number | null;
  customersUsed: number;
  customerLimit: number;
  subscriptionStatus: "active" | "exhausted" | "suspended" | "expired";
  subscriptionExpiresAt: string | null;
  subscriptionStartedAt: string | null;
  partnerId?: number | null;
  partnerName?: string | null;
  partnerCode?: string | null;
  createdAt: string;
}

export interface MenuCategory {
  id: number;
  restaurantId: number;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

export interface MenuItem {
  id: number;
  restaurantId: number;
  categoryId: number;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  isAvailable: boolean;
  isVeg: boolean;
  displayOrder: number;
}

export interface RestaurantTable {
  id: number;
  restaurantId: number;
  tableNumber: string;
  area: string | null;
  qrCodeUrl: string | null;
  isOccupied: boolean;
}

export interface OrderItem {
  id: number;
  orderId: number;
  menuItemId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  isVeg: boolean;
  notes: string | null;
}

export interface SessionBill {
  id: number;
  sessionId: number;
  restaurantId: number;
  billNumber: string;
  subtotal: number;
  tax: number;
  total: number;
  status: "generated" | "sent" | "awaiting_verification" | "paid" | "cancelled";
  customerPhone: string | null;
  sentAt: string | null;
  hasScreenshot: boolean;
  screenshotReceivedAt: string | null;
  senderPhone: string | null;
  phoneMismatch: boolean;
  verifiedAt: string | null;
  verifiedBy: number | null;
  resentAt: string | null;
  resentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentScreenshotInboxEntry {
  id: number;
  restaurantId: number;
  receivedAt: string;
  senderJid: string | null;
  senderPhone: string | null;
  source: string;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  matchedSessionId: number | null;
  matchedBillId: number | null;
  matchingStrategy: string | null;
  isDuplicate: boolean;
  hasScreenshot: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentScreenshotInboxResponse {
  entries: PaymentScreenshotInboxEntry[];
  total: number;
  page: number;
  totalPages: number;
}

export interface HistorySessionBill {
  id: number;
  sessionId: number;
  billNumber: string;
  subtotal: number;
  tax: number;
  total: number;
  status: "generated" | "sent" | "awaiting_verification" | "paid" | "cancelled";
  customerPhone: string | null;
  billGeneratedAt: string;
  billSentAt: string | null;
  screenshotReceivedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: number | null;
  verifiedByName: string | null;
  resentAt: string | null;
  resentCount: number;
  hasScreenshot: boolean;
}

export interface HistoryOrderItem {
  id: number;
  name: string;
  quantity: number;
  unitPrice: number;
  isVeg: boolean;
  notes: string | null;
}

export interface HistoryOrder {
  id: number;
  customerName: string;
  customerPhone: string;
  status: string;
  subtotal: number;
  tax: number;
  total: number;
  paymentStatus: string;
  createdAt: string;
  items: HistoryOrderItem[];
}

export interface HistorySession {
  id: number;
  /** Null for takeaway sessions */
  tableNumber: string | null;
  sessionType: "dine_in" | "takeaway";
  status: "active" | "awaiting_payment" | "awaiting_verification" | "paid" | "closed";
  orderCount: number;
  itemCount: number;
  totalAmount: number;
  customerName: string | null;
  customerPhone: string | null;
  sessionOpenedAt: string;
  sessionClosedAt: string | null;
  bill: HistorySessionBill | null;
}

export interface HistorySessionDetail extends HistorySession {
  orders: HistoryOrder[];
}

export interface HistoryRevenue {
  today: number;
  thisWeek: number;
  thisMonth: number;
}

export interface HistoryPage {
  sessions: HistorySession[];
  total: number;
  page: number;
  totalPages: number;
}

export interface SessionSummary {
  id: number;
  /** Null for takeaway sessions */
  tableNumber: string | null;
  sessionType: "dine_in" | "takeaway";
  /** Normalized phone used to group takeaway orders (e.g. "919876543210") */
  customerPhone: string | null;
  status: "active" | "awaiting_payment" | "awaiting_verification" | "paid" | "closed";
  orderCount: number;
  itemCount: number;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  orders: Order[];
  bill: SessionBill | null;
}

export interface Order {
  id: number;
  restaurantId: number;
  sessionId: number | null;
  tableId: number | null;
  tableNumber: string | null;
  customerName: string;
  customerPhone: string;
  status: "ordered" | "pending_payment" | "awaiting_confirmation" | "pending" | "confirmed" | "preparing" | "ready" | "completed" | "cancelled" | "payment_failed";
  subtotal: number;
  tax: number;
  total: number;
  paymentStatus: "unpaid" | "paid" | "manual_review" | "awaiting_verification";
  paymentMethod: string | null;
  notes: string | null;
  paymentScreenshotUrl: string | null;  // null in list responses — only present in individual order fetch
  hasScreenshot?: boolean;
  paymentOcrData: string | null;
  paymentVerificationStatus: string | null;
  verificationMethod: string | null;
  verifiedBy: number | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

export interface DashboardStats {
  restaurantName: string | null;
  todayOrders: number;
  todayRevenue: number;
  activeOrders: number;
  pendingOrders: number;
  totalMenuItems: number;
  totalTables: number;
  subscriptionStatus: "active" | "exhausted" | "suspended" | "expired";
  customerLimit: number;
  customersUsed: number;
  subscriptionExpiresAt: string | null;
  subscriptionStartedAt: string | null;
  planId: number | null;
  hasPendingUpi: boolean;
  upiVerified: boolean;
  verifiedAt: string | null;
}

export interface RestaurantWithOwner extends Restaurant {
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerTempPassword: string | null;
  totalOrders: number;
  totalRevenue: number;
  planName: string | null;
  subscriptionExpiresAt: string | null;
  qrStandsCount?: number;
  hardwareOrderId?: number | null;
  hardwareQuantity?: number;
  hardwareUnitPrice?: number;
  hardwareTotalAmount?: number;
  hardwareCollectionStatus?: string;
  hardwareCollectedAt?: string | null;
  hardwarePartnerId?: number | null;
  hardwarePartnerName?: string | null;
}

export interface AdminStats {
  totalRestaurants: number;
  activeRestaurants: number;
  suspendedRestaurants: number;
  totalOrders: number;
  totalRevenue: number;
  totalCustomers: number;
  subscriptionRevenue: number;
  exhaustedRestaurants: number;
}

export interface AdminCustomer {
  customerPhone: string;
  customerName: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: string;
  restaurants: string[];
  state: string | null;
  district: string | null;
  city: string | null;
}

// ── Payment Screenshot Inbox (migration 0028) ─────────────────────────────────

export interface ScreenshotInboxEntry {
  id: number;
  restaurantId: number;
  receivedAt: string;
  senderJid: string | null;
  senderPhone: string | null;
  source: string;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  matchedSessionId: number | null;
  matchedBillId: number | null;
  matchingStrategy: string | null;
  isDuplicate: boolean;
  /** True when screenshot_data is still present (not yet purged by retention policy) */
  hasScreenshot: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScreenshotInboxPage {
  entries: ScreenshotInboxEntry[];
  total: number;
  page: number;
  totalPages: number;
}

// ── Partner Channel Types ───────────────────────────────────────────────────

export interface PartnerPayoutDetails {
  upiId?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  bankName?: string | null;
  updatedAt?: string | null;
}

export interface PartnerProfile {
  id: number;
  userId: number;
  name: string;
  email: string;
  phone: string;
  state?: string | null;
  city?: string | null;
  referralCode: string | null;
  commissionPercentage: number;
  status: "pending" | "active" | "suspended" | "rejected";
  payoutDetails: PartnerPayoutDetails | null;
  createdAt: string;
  updatedAt: string;
  tempPassword?: string | null;
  loginPassword?: string | null;
}

export interface PartnerMetrics {
  totalRestaurants: number;
  activeRestaurants: number;
  totalEarned: number;
  pendingPayout: number;
  approvedPayout: number;
  paidPayout: number;
}

export interface PartnerRestaurantItem {
  id: number;
  name: string;
  slug: string;
  phone: string;
  email: string;
  city: string;
  address?: string | null;
  cuisineType?: string | null;
  subscriptionStatus: string;
  customerLimit?: number;
  customersUsed?: number;
  isActive: boolean;
  planId?: number | null;
  planName?: string | null;
  createdAt: string;
}

export interface PartnerCommissionItem {
  id: number;
  partnerId: number;
  restaurantId: number;
  restaurantName?: string | null;
  restaurantCity?: string | null;
  subscriptionTransactionId: number;
  transactionAmount: number;
  commissionRate: number;
  commissionAmount: number;
  currency: string;
  status: "pending" | "approved" | "paid" | "cancelled";
  payoutReference: string | null;
  paidAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface PartnerDashboardData {
  partner: PartnerProfile;
  metrics: PartnerMetrics;
  recentRestaurants: PartnerRestaurantItem[];
  recentCommissions: PartnerCommissionItem[];
  isUnderReview?: boolean;
}

