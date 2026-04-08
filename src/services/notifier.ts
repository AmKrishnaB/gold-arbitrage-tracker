import { config } from '../config/index.js';
import type { Deal, DealStatus, NormalizedProduct } from '../config/types.js';
import { getDB } from '../db/index.js';
import { activeDeals, sentMessages, subscribers } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { formatDealMessage, formatExpiredMessage } from '../bot/templates.js';
import { sendMessage, editMessage, sendMessageWithKeyboard, getActiveSubscribers } from '../bot/index.js';
import { InlineKeyboard } from 'grammy';
import { logger } from '../utils/logger.js';

// ─── Pending Approval Store ───
// Maps dealId → Deal object so we can broadcast after admin approves
const pendingApprovalDeals = new Map<number, Deal>();

/**
 * Get a pending deal by its DB id (for admin approval callback).
 */
export function getPendingDeal(dealId: number): Deal | undefined {
  return pendingApprovalDeals.get(dealId);
}

/**
 * Remove a deal from the pending map.
 */
export function removePendingDeal(dealId: number): void {
  pendingApprovalDeals.delete(dealId);
}

/**
 * Check if a deal needs admin approval.
 * Deals with savings > adminApprovalThresholdPct below spot need approval.
 */
function needsAdminApproval(deal: Deal): boolean {
  return deal.totalSavingsPct > config.adminApprovalThresholdPct;
}

/**
 * Process newly detected deals — decide whether to send new notification,
 * edit existing, or suppress.
 */
export async function processDeals(
  deals: Deal[],
  allProducts: NormalizedProduct[],
): Promise<void> {
  const db = getDB();
  const now = Date.now();

  // Get all current active/pending deals from DB
  const existingDeals = await db.select().from(activeDeals)
    .where(inArray(activeDeals.status, ['active', 'pending_approval']))
    .all();
  const existingMap = new Map(existingDeals.map((d) => [d.productId, d]));

  logger.info(
    { newDeals: deals.length, existingActive: existingDeals.length },
    'processDeals: starting',
  );

  // Track which products are still deals
  const currentDealProductIds = new Set(deals.map((d) => d.product.id));

  // ─── Handle NEW and UPDATED deals ───

  for (const deal of deals) {
    const existing = existingMap.get(deal.product.id);

    if (!existing) {
      // NEW DEAL — never seen before
      try {
        await handleNewDeal(deal);
      } catch (err) {
        logger.error({ productId: deal.product.id, error: (err as Error).message }, 'handleNewDeal failed');
      }
    } else if (existing.status === 'pending_approval') {
      // Still pending — update price in DB but don't re-send to admin
      await db.update(activeDeals).set({
        currentPrice: deal.finalPrice,
        currentSavingsPct: deal.totalSavingsPct,
        marketValue: deal.marketValue,
      }).where(eq(activeDeals.id, existing.id));
      // Keep the pending deal object up-to-date
      pendingApprovalDeals.set(existing.id, deal);
    } else {
      // EXISTING ACTIVE DEAL — check if we should update
      await handleExistingDeal(deal, existing);
    }
  }

  // ─── Handle EXPIRED deals ───
  for (const existing of existingDeals) {
    if (!currentDealProductIds.has(existing.productId)) {
      if (existing.status === 'pending_approval') {
        // Was pending approval but deal is gone — just clean up
        await db.update(activeDeals).set({
          status: 'expired',
          dealGoneAt: now,
        }).where(eq(activeDeals.id, existing.id));
        pendingApprovalDeals.delete(existing.id);
        logger.info({ productId: existing.productId }, 'Pending deal expired before approval');
      } else {
        // Active deal no longer valid
        await handleExpiredDeal(existing, allProducts);
      }
    }
  }
}

/**
 * Handle a newly discovered deal.
 */
async function handleNewDeal(deal: Deal): Promise<void> {
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

  const requiresApproval = needsAdminApproval(deal);
  const initialStatus = requiresApproval ? 'pending_approval' : 'active';

  // Insert deal record
  let dealId: number;
  try {
    const result = db.insert(activeDeals).values({
      productId: deal.product.id,
      platform: deal.product.platform,
      firstDetectedAt: now,
      lastNotifiedAt: now,
      lastNotifiedPrice: deal.finalPrice,
      lastNotifiedSavingsPct: deal.totalSavingsPct,
      lastPromoHash: '',
      currentPrice: deal.finalPrice,
      currentSavingsPct: deal.totalSavingsPct,
      marketValue: deal.marketValue,
      status: initialStatus,
      notificationCount: requiresApproval ? 0 : 1,
    }).returning().get();

    if (!result) {
      logger.error({ productId: deal.product.id }, 'handleNewDeal: insert returned null');
      return;
    }
    dealId = result.id;
  } catch (err) {
    logger.error({ productId: deal.product.id, error: (err as Error).message }, 'handleNewDeal: DB insert failed');
    return;
  }

  const affiliateUrl = deal.affiliateUrl || deal.product.url;
  const status = isDealBack ? 'deal_back' : 'active';
  const text = formatDealMessage(deal, affiliateUrl, status);

  if (requiresApproval) {
    // Store deal for later broadcast after approval
    pendingApprovalDeals.set(dealId, deal);

    // Send to admin with approve/reject buttons
    await sendAdminApproval(dealId, deal, text);

    logger.info(
      {
        productId: deal.product.id,
        dealId,
        savingsPct: deal.totalSavingsPct.toFixed(1),
      },
      'Deal sent to admin for approval (savings > threshold)',
    );
  } else {
    // Normal flow — broadcast to all subscribers
    logger.info({ productId: deal.product.id, dealId, textLen: text.length }, 'handleNewDeal: sending broadcast');
    await broadcastToSubscribers(dealId, deal, text);

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
}

/**
 * Send deal to admin with Approve / Reject inline buttons.
 */
async function sendAdminApproval(dealId: number, deal: Deal, dealText: string): Promise<void> {
  const adminChatId = config.telegramAdminChatId;
  if (!adminChatId) {
    logger.error('No admin chat ID configured — cannot request approval');
    return;
  }

  const header =
    `⚠️ DEAL NEEDS APPROVAL (${deal.totalSavingsPct.toFixed(1)}% below spot)\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const keyboard = new InlineKeyboard()
    .text('✅ Approve & Send', `approve_deal:${dealId}`)
    .text('❌ Reject', `reject_deal:${dealId}`);

  await sendMessageWithKeyboard(adminChatId, header + dealText, keyboard);
}

/**
 * Called when admin approves a deal — broadcast to all subscribers.
 */
export async function approveDeal(dealId: number): Promise<{ success: boolean; reason?: string }> {
  const db = getDB();
  const deal = pendingApprovalDeals.get(dealId);

  if (!deal) {
    return { success: false, reason: 'Deal no longer in pending queue (expired or already handled)' };
  }

  // Update status to active
  await db.update(activeDeals).set({
    status: 'active',
    lastNotifiedAt: Date.now(),
    notificationCount: 1,
  }).where(eq(activeDeals.id, dealId));

  // Broadcast to subscribers
  const affiliateUrl = deal.affiliateUrl || deal.product.url;
  const text = formatDealMessage(deal, affiliateUrl, 'active');
  await broadcastToSubscribers(dealId, deal, text);

  // Clean up
  pendingApprovalDeals.delete(dealId);

  logger.info({ dealId, productId: deal.product.id }, 'Deal approved by admin and broadcast');
  return { success: true };
}

/**
 * Called when admin rejects a deal — mark as rejected, don't broadcast.
 */
export async function rejectDeal(dealId: number): Promise<{ success: boolean; reason?: string }> {
  const db = getDB();
  const deal = pendingApprovalDeals.get(dealId);

  if (!deal) {
    return { success: false, reason: 'Deal no longer in pending queue (expired or already handled)' };
  }

  // Mark as rejected in DB
  await db.update(activeDeals).set({
    status: 'rejected',
  }).where(eq(activeDeals.id, dealId));

  // Clean up
  pendingApprovalDeals.delete(dealId);

  logger.info({ dealId, productId: deal.product.id }, 'Deal rejected by admin');
  return { success: true };
}

/**
 * Handle an existing deal — check for price drops, offer changes.
 */
async function handleExistingDeal(
  deal: Deal,
  existing: typeof activeDeals.$inferSelect,
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
  const savingsChange = Math.abs(deal.totalSavingsPct - existing.lastNotifiedSavingsPct);

  // Determine action
  const cooldownPassed = (now - existing.lastNotifiedAt) > config.editCooldownMinutes * 60 * 1000;

  if (priceDrop && cooldownPassed) {
    // Price dropped — edit existing message
    const affiliateUrl = deal.affiliateUrl || deal.product.url;
    const text = formatDealMessage(deal, affiliateUrl, 'price_drop');
    await editBroadcast(existing.id, text);

    await db.update(activeDeals).set({
      lastNotifiedAt: now,
      lastNotifiedPrice: deal.finalPrice,
      lastNotifiedSavingsPct: deal.totalSavingsPct,
    }).where(eq(activeDeals.id, existing.id));

    logger.info({ productId: existing.productId, priceDrop: true, savingsChange: savingsChange.toFixed(1) }, 'Deal updated (price drop)');
  } else if (savingsChange >= config.silentEditThresholdPct && cooldownPassed) {
    // Market moved enough for silent edit
    const affiliateUrl = deal.affiliateUrl || deal.product.url;
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
    topBankOffers: [],
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

  logger.info({ dealId, subscribers: subs.length }, 'broadcastToSubscribers: starting');

  if (subs.length === 0) {
    logger.warn('broadcastToSubscribers: no active subscribers found!');
    return;
  }

  let sent = 0;
  for (const sub of subs) {
    // Skip admin for broadcasts — admin already got the approval message
    // (admin still gets deals that don't need approval, via normal flow)

    // Check min savings preference
    if (deal.totalSavings < sub.minSavingsRupees) {
      logger.debug({ chatId: sub.chatId, minSavings: sub.minSavingsRupees, dealSavings: deal.totalSavings }, 'Skipped: below min savings');
      continue;
    }
    if (sub.mode === 'digest') {
      logger.debug({ chatId: sub.chatId }, 'Skipped: digest mode');
      continue;
    }

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
    } else {
      logger.error({ chatId: sub.chatId, dealId }, 'broadcastToSubscribers: sendMessage returned null');
    }
  }

  logger.info({ dealId, sent, total: subs.length }, 'Broadcast complete');
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
