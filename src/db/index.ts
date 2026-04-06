import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import * as schema from './schema.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;

export function initDB(): typeof db {
  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  sqlite = new Database(config.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  db = drizzle(sqlite, { schema });

  // Create tables if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      url TEXT NOT NULL,
      weight_grams REAL NOT NULL,
      fineness INTEGER NOT NULL,
      karat INTEGER NOT NULL,
      is_combo INTEGER NOT NULL DEFAULT 0,
      piece_count INTEGER NOT NULL DEFAULT 1,
      mrp REAL NOT NULL,
      selling_price REAL NOT NULL,
      offer_price REAL,
      coupon_price REAL,
      effective_price REAL NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      weight_source TEXT NOT NULL,
      purity_source TEXT NOT NULL,
      parse_warnings TEXT,
      last_seen_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      rating REAL,
      rating_count INTEGER,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      effective_price REAL NOT NULL,
      mrp REAL NOT NULL,
      ibja_rate REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      platform TEXT NOT NULL,
      first_detected_at INTEGER NOT NULL,
      last_notified_at INTEGER NOT NULL,
      last_notified_price REAL NOT NULL,
      last_notified_savings_pct REAL NOT NULL,
      last_promo_hash TEXT NOT NULL DEFAULT '',
      current_price REAL NOT NULL,
      current_savings_pct REAL NOT NULL,
      market_value REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      notification_count INTEGER NOT NULL DEFAULT 0,
      deal_gone_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER NOT NULL REFERENCES active_deals(id),
      subscriber_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      last_status TEXT NOT NULL DEFAULT 'active',
      last_edited_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'instant',
      min_savings_rupees REAL NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      promos TEXT NOT NULL DEFAULT '[]',
      bank_offers TEXT NOT NULL DEFAULT '[]',
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ibja_rate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      session TEXT NOT NULL,
      gold_999 REAL NOT NULL,
      gold_995 REAL NOT NULL,
      gold_916 REAL NOT NULL,
      gold_750 REAL NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      total_products INTEGER NOT NULL,
      parsed_products INTEGER NOT NULL,
      failed_products INTEGER NOT NULL,
      deals_found INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL,
      errors TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_platform ON products(platform);
    CREATE INDEX IF NOT EXISTS idx_active_deals_status ON active_deals(status);
    CREATE INDEX IF NOT EXISTS idx_active_deals_product ON active_deals(product_id);
    CREATE INDEX IF NOT EXISTS idx_sent_messages_deal ON sent_messages(deal_id);
    CREATE INDEX IF NOT EXISTS idx_sent_messages_subscriber ON sent_messages(subscriber_chat_id);
    CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(is_active);
    CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id);
  `);

  logger.info({ dbPath: config.dbPath }, 'Database initialized');
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

export function closeDB() {
  if (sqlite) sqlite.close();
}
