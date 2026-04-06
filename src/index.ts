import { config } from './config/index.js';
import { initDB, closeDB } from './db/index.js';
import { fetchIBJARates } from './services/goldRate.js';
import { initBot } from './bot/index.js';
import { startScheduler, runScanCycle } from './services/scheduler.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('🟢 Gold Arbitrage Deal Tracker starting...');

  // Validate config
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is required. Set it in .env');
    process.exit(1);
  }

  // Initialize database
  initDB();
  logger.info('Database ready');

  // Fetch initial IBJA rates
  try {
    await fetchIBJARates();
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Initial IBJA fetch failed, will retry');
  }

  // Initialize Telegram bot
  const bot = initBot();
  logger.info('Telegram bot initialized');

  // Start the bot (long polling)
  bot.start({
    onStart: () => {
      logger.info('Telegram bot started (long polling)');
    },
  });

  // Start the scheduler
  startScheduler();

  // Run first scan immediately
  logger.info('Running initial scan...');
  await runScanCycle();

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    bot.stop();
    closeDB();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
