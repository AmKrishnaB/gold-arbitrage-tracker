import 'dotenv/config';

export const config = {
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',

  // EarnKaro
  earnkaroApiKey: process.env.EARNKARO_API_KEY || '',

  // Scanner
  scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '5', 10),
  ibjaFetchRetries: parseInt(process.env.IBJA_FETCH_RETRIES || '3', 10),

  // Database
  dbPath: process.env.DB_PATH || './data/gold-tracker.db',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // IBJA API
  ibjaApiUrl: 'https://ibja-api.vercel.app/latest',

  // Proxy for Myntra (needed on datacenter/cloud IPs)
  myntraProxy: process.env.MYNTRA_PROXY || '',

  // Notification thresholds
  silentEditThresholdPct: 2,   // Min savings % change to silent-edit a message
  renotifyThresholdPct: 5,     // Min savings % change to send new message
  editCooldownMinutes: 30,     // Min gap between edits for same deal
  dealGoneRenotifyHours: 6,    // Hours before "deal is back" triggers new msg

  // Price sanity
  maxReasonablePremiumMultiplier: 1.5, // 50% above spot = suspicious
} as const;

export type Config = typeof config;
