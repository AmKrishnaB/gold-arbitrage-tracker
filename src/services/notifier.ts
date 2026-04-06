import { config } from '../config/index.js';
import type { Deal, DealStatus, NormalizedProduct } from '../config/types.js';
import { getDB } from '../db/index.js';
import { activeDeals, sentMessages, subscribers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { formatDealMessage, formatExpiredMessage } from '../bot/templates.js';
import { sendMessage, editMessage, getActiveSubscribers } from '../bot/index.js';
import { generateAffiliateLink } from './earnkaro.js';
import { generatePromoHash } from './dealDetector.js';
import { logger } from '../utils/logger.js';
import type { PlatformOffers } from '../config/types.js';

/**
 * Process newly detected deals — decide whether to send new notification,
 * edit existing, or suppress.
 */
export async function processDeals(
  deals: Deal[],
  allProducts: NormalizedProduct[],
  offers?: PlatformOffers,
): Promise<void> {
  const db = getDB();
  const now = Date.now();

  // Get all current active deals from DB
  const existingDeals = await db.select().from(activeDeals).where(eq(activeDeals.status, 'active')).all();
  const existingMap = new Map(existingDeals.map((d) => [d.productId, d]));

  // Track which products are still deals
  const currentDealProductIds = new Set(deals.map((d) => d.product.id));

  // ─── Handle NEW and UPDATED deals ───
  const promoHash = offers ? generatePromoHash(offers) : '';

  for (const deal of deals) {
    const existing = existingMap.get(deal.product.id);

    if (!existing) {
      // NEW DEAL — never seen before
      await handleNewDeal(deal, promoHash);
    } else {
      // EXISTING DEAL — check if we should update
      await handleExistingDeal(deal, existing, promoHash);
    }
  }

  // ─── Handle EXPIRED deals ───
  for (const existing of existingDeals) {
    if (!currentDealProductIds.has(existing.productId)) {
      // Deal no longer valid
      await handleExpiredDeal(existing, allProducts);
    }
  }
}

/**
 * Handle a newly discovered deal.
 */
async function handleNewDeal(deal: Deal, promoHash: string): Promise<void> {
  const db = getDB();
  const now = Date.now();

  // Check if this deal was previously expired (for "deal is back" logic)
  const previousDeal = await db.select().from(activeDeals)
    .where(and(
      eq(activeDeals.productId, deal.product.id),
      eq(activeDeals.status, 'expired'),
    ))
    .get();

  const isDealBack = previousDeal &&
    previousDeal.dealGoneAt &&
    (now - previousDeal.dealGoneAt) > config.dealGoneRenotifyHours * 60 * 60 * 1000;

  // Insert/update active deal record
  const dealRecord = await db.insert(activeDeals).values({
    productId: deal.product.id,
    platform: deal.product.platform,
    firstDetectedAt: now,
    lastNotifiedAt: now,
    lastNotifiedPrice: deal.finalPrice,
    lastNotifiedSavingsPct: deal.totalSavingsPct,
    lastPromoHash: promoHash,
    currentPrice: deal.finalPrice,
    currentSavingsPct: deal.totalSavingsPct,
    marketValue: deal.marketValue,
    status: 'active',
    notificationCount: 1,
  }).returning().get();

  if (!dealRecord) return;

  // Generate affiliate link
  const affiliateUrl = await generateAffiliateLink(deal.product.url);

  // Format message
  const status = isDealBack ? 'deal_back' : 'active';
  const text = formatDealMessage(deal, affiliateUrl, status);

  // Send to all active subscribers
  await broadcastToSubscribers(dealRecord.id, deal, text);

  logger.info(
    {
      productId: deal.product.id,
      savings: deal.totalSavings,
      savingsPct: deal.totalSavingsPct.toFixed(1),
      isDealBack,
    },
    'New deal notified',
  );
}

/**
 * Handle an existing deal — check for price drops, offer changes.
 */
async function handleExistingDeal(
  deal: Deal,
  existing: typeof activeDeals.$inferSelect,
  promoHash: string,
): Promise<void> {
  const db = getDB();
  const now = Date.now();

  // Update current price in DB
  await db.update(activeDeals)
    .set({
      currentPrice: deal.finalPrice,
      currentSavingsPct: deal.totalSavingsPct,
      marketValue: deal.marketValue,
    })
    .where(eq(activeDeals.id, existing.id));

  // Check what changed
  const priceDrop = deal.finalPrice < existing.lastNotifiedPrice;
  const promoChanged = promoHash !== existing.lastPromoHash && promoHash !== '';
  const savingsChange = Math.abs(deal.totalSavingsPct - existing.lastNotifiedSavingsPct);

  // Determine action
  const cooldownPassed = (now - existing.lastNotifiedAt) > config.editCooldownMinutes * 60 * 1000;

  if (priceDrop && cooldownPassed) {
    // Price dropped — edit existing message
    const affiliateUrl = await generateAffiliateLink(deal.product.url);
    const text = formatDealMessage(deal, affiliateUrl, 'price_drop');
    await editBroadcast(existing.id, text);

    await db.update(activeDeals).set({
      lastNotifiedAt: now,
      lastNotifiedPrice: deal.finalPrice,
      lastNotifiedSavingsPct: deal.totalSavingsPct,
      lastPromoHash: promoHash,
    }).where(eq(activeDeals.id, existing.id));

    logger.info({ productId: existing.productId, priceDrop: true, savingsChange: savingsChange.toFixed(1) }, 'Deal updated (price drop)');
  } else if (promoChanged && cooldownPassed) {
    // New promo/bank offer
    const affiliateUrl = await generateAffiliateLink(deal.product.url);
    const text = formatDealMessage(deal, affiliateUrl, 'better_offer');
    await editBroadcast(existing.id, text);

    await db.update(activeDeals).set({
      lastNotifiedAt: now,
      lastPromoHash: promoHash,
      lastNotifiedSavingsPct: deal.totalSavingsPct,
    }).where(eq(activeDeals.id, existing.id));

    logger.info({ productId: existing.productId, promoChanged: true }, 'Deal updated (better offer)');
  } else if (savingsChange >= config.silentEditThresholdPct && cooldownPassed) {
    // Market moved enough for silent edit
    const affiliateUrl = await generateAffiliateLink(deal.product.url);
    const text = formatDealMessage(deal, affiliateUrl, 'active');
    await editBroadcast(existing.id, text);

    await db.update(activeDeals).set({
      lastNotifiedAt: now,
      lastNotifiedSavingsPct: deal.totalSavingsPct,
    }).where(eq(activeDeals.id, existing.id));
  }
  // else: SUPPRESS — no significant change
}

/**
 * Handle a deal that is no longer valid (expired or OOS).
 */
async function handleExpiredDeal(
  existing: typeof activeDeals.$inferSelect,
  allProducts: NormalizedProduct[],
): Promise<void> {
  const db = getDB();
  const now = Date.now();

  // Check if product is OOS or just above market
  const product = allProducts.find((p) => p.id === existing.productId);
  const reason: DealStatus = product ? 'expired' : 'oos';

  // Update DB
  await db.update(activeDeals).set({
    status: reason,
    dealGoneAt: now,
  }).where(eq(activeDeals.id, existing.id));

  // Edit messages to show expired/OOS status
  const dummyDeal: Deal = {
    product: product ?? {
      id: existing.productId,
      platform: existing.platform as 'myntra' | 'ajio',
      name: 'Unknown Product',
      brand: '',
      url: '',
      totalWeightGrams: 0,
      fineness: 999,
      karat: 24,
      isCombo: false,
      pieceCount: 1,
      mrp: existing.currentPrice,
      sellingPrice: existing.currentPrice,
      effectivePrice: existing.currentPrice,
      discountPercent: 0,
      weightSource: 'unknown',
      puritySource: 'unknown',
      parseWarnings: [],
    },
    marketValue: existing.marketValue,
    effectivePrice: existing.currentPrice,
    savings: 0,
    savingsPct: 0,
    promoSavings: 0,
    bankOfferSavings: 0,
    finalPrice: existing.currentPrice,
    totalSavings: 0,
    totalSavingsPct: 0,
    ibjaRate: 0,
    ibjaSession: 'AM',
    detectedAt: now,
  };

  const text = formatExpiredMessage(dummyDeal, reason, existing.firstDetectedAt);
  await editBroadcast(existing.id, text);

  logger.info({ productId: existing.productId, reason }, 'Deal expired');
}

// ─── Broadcast Helpers ───

async function broadcastToSubscribers(
  dealId: number,
  deal: Deal,
  text: string,
): Promise<void> {
  const db = getDB();
  const subs = await getActiveSubscribers();

  // Batch: send top 3 deals individually, rest as summary
  let sent = 0;
  for (const sub of subs) {
    // Check min savings preference
    if (deal.totalSavings < sub.minSavingsRupees) continue;
    if (sub.mode === 'digest') continue; // Skip for digest-only users

    const messageId = await sendMessage(sub.chatId, text);
    if (messageId) {
      await db.insert(sentMessages).values({
        dealId,
        subscriberChatId: sub.chatId,
        telegramMessageId: messageId,
        lastStatus: 'active',
        lastEditedAt: Date.now(),
        createdAt: Date.now(),
      });
      sent++;
    }
  }

  logger.debug({ dealId, sent, total: subs.length }, 'Broadcast complete');
}

async function editBroadcast(dealId: number, text: string): Promise<void> {
  const db = getDB();
  const messages = await db.select().from(sentMessages)
    .where(eq(sentMessages.dealId, dealId))
    .all();

  for (const msg of messages) {
    const success = await editMessage(msg.subscriberChatId, msg.telegramMessageId, text);
    if (success) {
      await db.update(sentMessages).set({ lastEditedAt: Date.now() }).where(eq(sentMessages.id, msg.id!));
    }
  }
}
