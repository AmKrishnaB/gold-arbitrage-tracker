import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getDB } from '../db/index.js';
import { subscribers, activeDeals, sentMessages } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getCachedRates } from '../services/goldRate.js';
import { formatGoldRateMessage, formatDealsSummary, DEALS_PAGE_SIZE } from './templates.js';
import type { Deal } from '../config/types.js';
import { approveDeal, rejectDeal } from '../services/notifier.js';

let bot: Bot;
let activeDealsList: Deal[] = [];
let forceScanCallback: (() => Promise<void>) | null = null;

/**
 * Register the force scan callback (called from scheduler to avoid circular imports).
 */
export function registerForceScan(callback: () => Promise<void>): void {
  forceScanCallback = callback;
}

export function initBot(): Bot {
  bot = new Bot(config.telegramBotToken);

  // Disable link previews globally for all outgoing messages
  bot.api.config.use((prev, method, payload, signal) => {
    if ('link_preview_options' in payload || method === 'sendMessage' || method === 'editMessageText') {
      (payload as any).link_preview_options = { is_disabled: true };
    }
    return prev(method, payload, signal);
  });

  // ─── Commands ───

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const db = getDB();

    // Upsert subscriber
    const existing = await db.select().from(subscribers).where(eq(subscribers.chatId, chatId)).get();
    if (!existing) {
      await db.insert(subscribers).values({
        chatId,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        isAdmin: chatId === config.telegramAdminChatId,
        isActive: true,
        mode: 'instant',
        minSavingsRupees: 0,
        joinedAt: Date.now(),
      });
      logger.info({ chatId, username: ctx.from?.username }, 'New subscriber');
    } else if (!existing.isActive) {
      await db.update(subscribers).set({ isActive: true }).where(eq(subscribers.chatId, chatId));
    }

    const welcomeText =
      '🟢 Welcome to Gold Arbitrage Deal Tracker!\n\n' +
      'I scan Myntra & Ajio for gold coins/bars priced below IBJA spot rate.\n\n' +
      'Commands:\n' +
      '/deals — View active deals\n' +
      '/gold — Current IBJA gold rates\n' +
      '/settings — Notification preferences\n' +
      '/stop — Unsubscribe\n\n' +
      'You\'ll receive instant alerts when deals are found!';

    if (activeDealsList.length > 0) {
      const keyboard = new InlineKeyboard().text(
        `🔥 View ${activeDealsList.length} Active Deal${activeDealsList.length > 1 ? 's' : ''}`,
        'show_active_deals',
      );
      await ctx.reply(welcomeText, { reply_markup: keyboard });
    } else {
      await ctx.reply(welcomeText);
    }
  });

  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const db = getDB();
    await db.update(subscribers).set({ isActive: false }).where(eq(subscribers.chatId, chatId));
    await ctx.reply('🔴 Unsubscribed. Use /start to re-subscribe anytime.');
    logger.info({ chatId }, 'Subscriber deactivated');
  });

  bot.command('gold', async (ctx) => {
    const rates = getCachedRates();
    if (!rates) {
      await ctx.reply('⏳ Gold rates not loaded yet. Try again in a moment.');
      return;
    }
    await ctx.reply(formatGoldRateMessage(rates.date, rates.session, rates.perGram));
  });

  bot.command('deals', async (ctx) => {
    const page = 0;
    const text = formatDealsSummary(activeDealsList, page);
    const keyboard = buildDealsKeyboard(page, activeDealsList.length);
    await ctx.reply(text, { reply_markup: keyboard ?? undefined });
  });

  // ─── Inline Keyboard: Deals Pagination ───

  bot.callbackQuery(/^deals_page:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match![1]);
    const text = formatDealsSummary(activeDealsList, page);
    const keyboard = buildDealsKeyboard(page, activeDealsList.length);
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard ?? undefined });
    } catch (err) {
      const errMsg = (err as Error).message;
      if (!errMsg.includes('message is not modified')) {
        logger.error({ error: errMsg }, 'Failed to edit deals page');
      }
    }
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('deals_page_noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('show_active_deals', async (ctx) => {
    const page = 0;
    const text = formatDealsSummary(activeDealsList, page);
    const keyboard = buildDealsKeyboard(page, activeDealsList.length);
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard ?? undefined });
    } catch (err) {
      const errMsg = (err as Error).message;
      if (!errMsg.includes('message is not modified')) {
        logger.error({ error: errMsg }, 'Failed to show active deals');
      }
    }
    await ctx.answerCallbackQuery();
  });

  // ─── Admin Approval: Approve / Reject ───

  bot.callbackQuery(/^approve_deal:(\d+)$/, async (ctx) => {
    if (ctx.chat?.id.toString() !== config.telegramAdminChatId) {
      await ctx.answerCallbackQuery({ text: 'Only admin can approve deals.' });
      return;
    }

    const dealId = parseInt(ctx.match![1]);
    const result = await approveDeal(dealId);

    if (result.success) {
      try {
        // Replace the approval message with confirmation (remove buttons)
        const originalText = ctx.callbackQuery.message?.text ?? '';
        const approvedText = originalText
          .replace('⚠️ DEAL NEEDS APPROVAL', '✅ APPROVED & SENT')
          .replace(/━+/, '━━━━━━━━━━━━━━━━━━━━━');
        await ctx.editMessageText(approvedText);
      } catch (err) {
        const errMsg = (err as Error).message;
        if (!errMsg.includes('message is not modified')) {
          logger.error({ error: errMsg }, 'Failed to edit approval message');
        }
      }
      await ctx.answerCallbackQuery({ text: '✅ Deal approved and sent to all subscribers!' });
    } else {
      await ctx.answerCallbackQuery({ text: `❌ ${result.reason}` });
    }
  });

  bot.callbackQuery(/^reject_deal:(\d+)$/, async (ctx) => {
    if (ctx.chat?.id.toString() !== config.telegramAdminChatId) {
      await ctx.answerCallbackQuery({ text: 'Only admin can reject deals.' });
      return;
    }

    const dealId = parseInt(ctx.match![1]);
    const result = await rejectDeal(dealId);

    if (result.success) {
      try {
        const originalText = ctx.callbackQuery.message?.text ?? '';
        const rejectedText = originalText
          .replace('⚠️ DEAL NEEDS APPROVAL', '❌ REJECTED')
          .replace(/━+/, '━━━━━━━━━━━━━━━━━━━━━');
        await ctx.editMessageText(rejectedText);
      } catch (err) {
        const errMsg = (err as Error).message;
        if (!errMsg.includes('message is not modified')) {
          logger.error({ error: errMsg }, 'Failed to edit rejection message');
        }
      }
      await ctx.answerCallbackQuery({ text: '❌ Deal rejected — not sent to subscribers.' });
    } else {
      await ctx.answerCallbackQuery({ text: `❌ ${result.reason}` });
    }
  });

  bot.command('settings', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const db = getDB();
    const sub = await db.select().from(subscribers).where(eq(subscribers.chatId, chatId)).get();

    if (!sub) {
      await ctx.reply('Use /start first to subscribe.');
      return;
    }

    await ctx.reply(
      `⚙️ Your Settings\n\n` +
      `Mode: ${sub.mode}\n` +
      `Min Savings: ₹${sub.minSavingsRupees}\n` +
      `Status: ${sub.isActive ? 'Active' : 'Inactive'}\n\n` +
      `Commands:\n` +
      `/mode instant — Real-time alerts\n` +
      `/mode digest — Daily summary only\n` +
      `/minsave 500 — Only notify for ₹500+ savings`,
    );
  });

  bot.command('mode', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const mode = ctx.match?.trim() as 'instant' | 'digest' | 'both';
    if (!['instant', 'digest', 'both'].includes(mode)) {
      await ctx.reply('Usage: /mode instant | digest | both');
      return;
    }
    const db = getDB();
    await db.update(subscribers).set({ mode }).where(eq(subscribers.chatId, chatId));
    await ctx.reply(`✅ Mode set to: ${mode}`);
  });

  bot.command('minsave', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const amount = parseInt(ctx.match?.trim() ?? '');
    if (isNaN(amount) || amount < 0) {
      await ctx.reply('Usage: /minsave 500 (minimum savings in ₹)');
      return;
    }
    const db = getDB();
    await db.update(subscribers).set({ minSavingsRupees: amount }).where(eq(subscribers.chatId, chatId));
    await ctx.reply(`✅ Min savings set to: ₹${amount}`);
  });

  // ─── Admin Commands ───

  bot.command('status', async (ctx) => {
    if (ctx.chat.id.toString() !== config.telegramAdminChatId) return;

    const rates = getCachedRates();
    const db = getDB();
    const subCount = await db.select().from(subscribers).where(eq(subscribers.isActive, true)).all();

    await ctx.reply(
      `📊 Bot Status\n\n` +
      `Subscribers: ${subCount.length}\n` +
      `Active Deals: ${activeDealsList.length}\n` +
      `IBJA Date: ${rates?.date ?? 'N/A'}\n` +
      `IBJA Session: ${rates?.session ?? 'N/A'}\n` +
      `Gold 999: ₹${rates?.perGram[999] ?? 'N/A'}/gm\n` +
      `Last Fetch: ${rates ? new Date(rates.fetchedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`,
    );
  });

  bot.command('force_scan', async (ctx) => {
    if (ctx.chat.id.toString() !== config.telegramAdminChatId) return;
    await ctx.reply('🔄 Force scan triggered. Results will follow...');
    if (forceScanCallback) {
      forceScanCallback().catch((err) => {
        logger.error({ error: (err as Error).message }, 'Force scan failed');
      });
    }
  });

  bot.command('force_resend', async (ctx) => {
    if (ctx.chat.id.toString() !== config.telegramAdminChatId) return;
    await clearDealHistory();
    await ctx.reply('🗑️ Deal history cleared. Running scan now — all deals will be sent as new notifications...');
    if (forceScanCallback) {
      forceScanCallback().catch((err) => {
        logger.error({ error: (err as Error).message }, 'Force resend scan failed');
      });
    }
  });

  // Error handling
  bot.catch((err) => {
    logger.error({ error: err.message }, 'Bot error');
  });

  return bot;
}

export function getBot(): Bot {
  if (!bot) throw new Error('Bot not initialized. Call initBot() first.');
  return bot;
}

export function updateActiveDeals(deals: Deal[]) {
  activeDealsList = deals;
}

/**
 * Build inline keyboard for deals pagination.
 * Returns null if only one page (no buttons needed).
 */
function buildDealsKeyboard(page: number, totalDeals: number): InlineKeyboard | null {
  const totalPages = Math.ceil(totalDeals / DEALS_PAGE_SIZE);
  if (totalPages <= 1) return null;

  const keyboard = new InlineKeyboard();

  if (page > 0) {
    keyboard.text('◀️ Prev', `deals_page:${page - 1}`);
  }

  keyboard.text(`${page + 1} / ${totalPages}`, 'deals_page_noop');

  if (page < totalPages - 1) {
    keyboard.text('Next ▶️', `deals_page:${page + 1}`);
  }

  return keyboard;
}

/**
 * Clear all active deals and sent message records from DB.
 * This forces the next scan cycle to treat all deals as NEW and re-send notifications.
 */
export async function clearDealHistory(): Promise<void> {
  const db = getDB();
  // Delete all sent messages first (FK constraint)
  await db.delete(sentMessages).run();
  // Delete all active deals
  await db.delete(activeDeals).run();
  logger.info('Deal history cleared — next scan will re-notify all deals');
}

/**
 * Send a message to a specific chat ID.
 */
export async function sendMessage(chatId: string, text: string): Promise<number | null> {
  try {
    const msg = await bot.api.sendMessage(chatId, text, { parse_mode: undefined, link_preview_options: { is_disabled: true } });
    return msg.message_id;
  } catch (err) {
    logger.error({ chatId, error: (err as Error).message }, 'Failed to send message');
    return null;
  }
}

/**
 * Send a message with an inline keyboard to a specific chat ID.
 */
export async function sendMessageWithKeyboard(chatId: string, text: string, keyboard: InlineKeyboard): Promise<number | null> {
  try {
    const msg = await bot.api.sendMessage(chatId, text, {
      parse_mode: undefined,
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    return msg.message_id;
  } catch (err) {
    logger.error({ chatId, error: (err as Error).message }, 'Failed to send message with keyboard');
    return null;
  }
}

/**
 * Edit an existing message in a chat.
 */
export async function editMessage(chatId: string, messageId: number, text: string): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, messageId, text, { link_preview_options: { is_disabled: true } });
    return true;
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('message is not modified')) return true; // No change needed
    if (errMsg.includes('message to edit not found')) return false; // User deleted it
    logger.error({ chatId, messageId, error: errMsg }, 'Failed to edit message');
    return false;
  }
}

/**
 * Get all active subscribers.
 */
export async function getActiveSubscribers() {
  const db = getDB();
  return db.select().from(subscribers).where(eq(subscribers.isActive, true)).all();
}
