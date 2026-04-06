import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getDB } from '../db/index.js';
import { subscribers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getCachedRates } from '../services/goldRate.js';
import { formatGoldRateMessage, formatDealsSummary } from './templates.js';
import type { Deal } from '../config/types.js';

let bot: Bot;
let activeDealsList: Deal[] = [];

export function initBot(): Bot {
  bot = new Bot(config.telegramBotToken);

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

    await ctx.reply(
      '🟢 Welcome to Gold Arbitrage Deal Tracker!\n\n' +
      'I scan Myntra & Ajio for gold coins/bars priced below IBJA spot rate.\n\n' +
      'Commands:\n' +
      '/deals — View active deals\n' +
      '/gold — Current IBJA gold rates\n' +
      '/settings — Notification preferences\n' +
      '/stop — Unsubscribe\n\n' +
      'You\'ll receive instant alerts when deals are found!',
    );
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
    await ctx.reply(formatDealsSummary(activeDealsList));
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
    // The scheduler will pick this up via an event or direct call
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
 * Send a message to a specific chat ID.
 */
export async function sendMessage(chatId: string, text: string): Promise<number | null> {
  try {
    const msg = await bot.api.sendMessage(chatId, text, { parse_mode: undefined });
    return msg.message_id;
  } catch (err) {
    logger.error({ chatId, error: (err as Error).message }, 'Failed to send message');
    return null;
  }
}

/**
 * Edit an existing message in a chat.
 */
export async function editMessage(chatId: string, messageId: number, text: string): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, messageId, text);
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
