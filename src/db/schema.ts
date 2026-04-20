import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ─── Products ───
export const products = sqliteTable('products', {
  id: text('id').primaryKey(),                   // platform:productCode
  platform: text('platform').notNull(),          // myntra | ajio
  platformId: text('platform_id').notNull(),     // original product code/styleId
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  url: text('url').notNull(),

  // Parsed gold data
  weightGrams: real('weight_grams').notNull(),
  fineness: integer('fineness').notNull(),
  karat: integer('karat').notNull(),
  isCombo: integer('is_combo', { mode: 'boolean' }).notNull().default(false),
  pieceCount: integer('piece_count').notNull().default(1),

  // Latest pricing
  mrp: real('mrp').notNull(),
  sellingPrice: real('selling_price').notNull(),
  offerPrice: real('offer_price'),
  couponPrice: real('coupon_price'),
  effectivePrice: real('effective_price').notNull(),
  discountPercent: real('discount_percent').notNull().default(0),

  // Three-field pricing breakdown (nullable for back-compat with pre-migration rows;
  // Ajio always populates listed_price + promo_discount; bank_discount set by dealDetector
  // when PDP offers are fetched. Myntra populates listed_price + promo_discount only).
  listedPrice: real('listed_price'),
  promoDiscount: real('promo_discount'),
  bankDiscount: real('bank_discount'),

  // Parse metadata
  weightSource: text('weight_source').notNull(),
  puritySource: text('purity_source').notNull(),
  parseWarnings: text('parse_warnings'),          // JSON stringified

  // Status
  lastSeenAt: integer('last_seen_at').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

  // Optional
  rating: real('rating'),
  ratingCount: integer('rating_count'),
  imageUrl: text('image_url'),
});

// ─── Price History ───
export const priceHistory = sqliteTable('price_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: text('product_id').notNull().references(() => products.id),
  effectivePrice: real('effective_price').notNull(),
  mrp: real('mrp').notNull(),
  ibjaRate: real('ibja_rate').notNull(),
  recordedAt: integer('recorded_at').notNull(),
});

// ─── Active Deals ───
export const activeDeals = sqliteTable('active_deals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: text('product_id').notNull().references(() => products.id),
  platform: text('platform').notNull(),

  firstDetectedAt: integer('first_detected_at').notNull(),
  lastNotifiedAt: integer('last_notified_at').notNull(),
  lastNotifiedPrice: real('last_notified_price').notNull(),
  lastNotifiedSavingsPct: real('last_notified_savings_pct').notNull(),
  lastPromoHash: text('last_promo_hash').notNull().default(''),

  currentPrice: real('current_price').notNull(),
  currentSavingsPct: real('current_savings_pct').notNull(),
  marketValue: real('market_value').notNull(),

  status: text('status').notNull().default('active'),  // active | expired | oos
  notificationCount: integer('notification_count').notNull().default(0),
  dealGoneAt: integer('deal_gone_at'),
});

// ─── Sent Messages (for Telegram edit tracking) ───
export const sentMessages = sqliteTable('sent_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: integer('deal_id').notNull().references(() => activeDeals.id),
  subscriberChatId: text('subscriber_chat_id').notNull(),
  telegramMessageId: integer('telegram_message_id').notNull(),

  lastStatus: text('last_status').notNull().default('active'), // active | price_drop | better_offer | expired | oos
  lastEditedAt: integer('last_edited_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

// ─── Subscribers ───
export const subscribers = sqliteTable('subscribers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),

  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

  mode: text('mode').notNull().default('instant'),  // instant | digest | both
  minSavingsRupees: real('min_savings_rupees').notNull().default(0),

  joinedAt: integer('joined_at').notNull(),
});

// ─── Platform Offers Cache ───
export const platformOffers = sqliteTable('platform_offers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),

  // Promo codes (JSON array of AjioPromo)
  promos: text('promos').notNull().default('[]'),
  // Bank offers (JSON array of AjioBankOffer)
  bankOffers: text('bank_offers').notNull().default('[]'),

  fetchedAt: integer('fetched_at').notNull(),
});

// ─── IBJA Rate History ───
export const ibjaRateHistory = sqliteTable('ibja_rate_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  session: text('session').notNull(),        // AM | PM
  gold999: real('gold_999').notNull(),
  gold995: real('gold_995').notNull(),
  gold916: real('gold_916').notNull(),
  gold750: real('gold_750').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

// ─── Scan Log ───
export const scanLog = sqliteTable('scan_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  totalProducts: integer('total_products').notNull(),
  parsedProducts: integer('parsed_products').notNull(),
  failedProducts: integer('failed_products').notNull(),
  dealsFound: integer('deals_found').notNull(),
  durationMs: integer('duration_ms').notNull(),
  scannedAt: integer('scanned_at').notNull(),
  errors: text('errors'),
});

// ─── Admin Config ───
export const adminConfig = sqliteTable('admin_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
