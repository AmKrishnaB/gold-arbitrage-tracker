import axios from 'axios';
import { config } from '../config/index.js';
import type { IBJARates, GoldRates, Fineness } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

/** Maps fineness to the IBJA field prefix */
const FINENESS_TO_FIELD: Record<number, string> = {
  999.9: 'lblGold999',
  999: 'lblGold999',
  995: 'lblGold995',
  916: 'lblGold916',
  750: 'lblGold750',
  585: 'lblGold585',
};

let cachedRates: GoldRates | null = null;

/**
 * Fetch latest IBJA rates from the API.
 * Rates are published twice daily: ~12:05 PM (AM) and ~5:05 PM (PM).
 */
export async function fetchIBJARates(): Promise<GoldRates> {
  const raw = await retry(
    async () => {
      const res = await axios.get<IBJARates>(config.ibjaApiUrl, { timeout: 10_000 });
      return res.data;
    },
    { retries: config.ibjaFetchRetries, delayMs: 2000, label: 'IBJA API' },
  );

  const rates = parseIBJARates(raw);
  cachedRates = rates;

  logger.info(
    { date: rates.date, session: rates.session, gold999: rates.perGram[999] },
    'IBJA rates fetched',
  );

  return rates;
}

/**
 * Parse raw IBJA response into usable per-gram rates.
 * Uses PM rate if available (latest), falls back to AM.
 */
function parseIBJARates(raw: IBJARates): GoldRates {
  const pm999 = parseInt(raw.lblGold999_PM) || 0;
  const am999 = parseInt(raw.lblGold999_AM) || 0;

  // Determine which session is the latest with data
  const session: 'AM' | 'PM' = pm999 > 0 && pm999 !== am999 ? 'PM' : 'AM';
  const suffix = session === 'PM' ? '_PM' : '_AM';

  const getRate = (field: string): number => {
    const val = parseInt((raw as unknown as Record<string, string>)[field + suffix]) || 0;
    // IBJA rates are per 10 grams
    return val / 10;
  };

  return {
    date: raw.date,
    fetchedAt: Date.now(),
    session,
    perGram: {
      999: getRate('lblGold999'),
      995: getRate('lblGold995'),
      916: getRate('lblGold916'),
      750: getRate('lblGold750'),
      585: getRate('lblGold585'),
    },
  };
}

/**
 * Get IBJA per-gram rate for a given fineness.
 * Returns 0 if rates not loaded or fineness unknown.
 */
export function getIBJARateForFineness(fineness: Fineness): number {
  if (!cachedRates) return 0;

  // Map fineness to perGram key
  const keyMap: Record<number, keyof GoldRates['perGram']> = {
    999.9: 999, 999: 999, 995: 995, 916: 916, 750: 750, 585: 585,
  };
  const key = keyMap[fineness];
  if (!key) return 0;

  return cachedRates.perGram[key] || 0;
}

/**
 * Calculate market value of a gold product using IBJA rates.
 */
export function calculateMarketValue(weightGrams: number, fineness: Fineness): number {
  const ratePerGram = getIBJARateForFineness(fineness);
  if (ratePerGram <= 0) return -1;
  return weightGrams * ratePerGram;
}

/** Get the currently cached rates */
export function getCachedRates(): GoldRates | null {
  return cachedRates;
}

/** Check if rates are stale (older than 12 hours) */
export function areRatesStale(): boolean {
  if (!cachedRates) return true;
  const twelveHours = 12 * 60 * 60 * 1000;
  return Date.now() - cachedRates.fetchedAt > twelveHours;
}
