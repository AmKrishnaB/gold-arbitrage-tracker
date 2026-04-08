import cron from 'node-cron';
import { config } from '../config/index.js';
import { fetchIBJARates, getCachedRates } from './goldRate.js';
import { fetchAllAjioProducts } from '../scrapers/ajio.js';
import { fetchAllMyntraProducts } from '../scrapers/myntra.js';
import { detectDeals } from './dealDetector.js';
import { generateAffiliateLink } from './earnkaro.js';
import { processDeals } from './notifier.js';
import { updateActiveDeals } from '../bot/index.js';
import { getDB } from '../db/index.js';
import { products, scanLog, ibjaRateHistory } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import type { NormalizedProduct } from '../config/types.js';

let scanRunning = false;

/**
 * Run a full scan cycle:
 * 1. Fetch IBJA rates (if stale)
 * 2. Fetch products from Ajio + Myntra
 * 3. Detect deals (pre-filter → PDP verification → real offers)
 * 4. Generate affiliate links
 * 5. Process notifications
 */
export async function runScanCycle(): Promise<void> {
  if (scanRunning) {
    logger.warn('Scan cycle already running, skipping');
    return;
  }

  scanRunning = true;
  const startTime = Date.now();

  try {
    // 1. Ensure IBJA rates are loaded
    let rates = getCachedRates();
    if (!rates) {
      rates = await fetchIBJARates();
    }

    // 2. Fetch products from both platforms in parallel
    const [ajioProducts, myntraProducts] = await Promise.all([
      fetchAllAjioProducts().catch((err) => {
        logger.error({ error: err.message }, 'Ajio scan failed');
        return [] as NormalizedProduct[];
      }),
      fetchAllMyntraProducts().catch((err) => {
        logger.error({ error: err.message }, 'Myntra scan failed');
        return [] as NormalizedProduct[];
      }),
    ]);

    const allProducts = [...ajioProducts, ...myntraProducts];

    // 3. Upsert all products into DB (required before deal detection — FK constraint)
    await upsertProducts(allProducts);

    // 4. Detect deals (2-phase: pre-filter → PDP verify with real offers)
    const deals = await detectDeals(allProducts, rates);

    // 5. Generate affiliate links for all deals
    if (deals.length > 0) {
      logger.info({ count: deals.length }, 'Generating affiliate links...');
      for (const deal of deals) {
        deal.affiliateUrl = await generateAffiliateLink(deal.product.url);
      }
    }

    // Update the bot's active deals list (for /deals command — now with affiliate URLs)
    updateActiveDeals(deals);

    // 6. Process notifications
    if (deals.length > 0) {
      await processDeals(deals, allProducts);
    }

    // Log scan results
    const duration = Date.now() - startTime;
    const db = getDB();
    await db.insert(scanLog).values({
      platform: 'all',
      totalProducts: allProducts.length,
      parsedProducts: allProducts.length,
      failedProducts: 0,
      dealsFound: deals.length,
      durationMs: duration,
      scannedAt: Date.now(),
    });

    logger.info({
      ajioProducts: ajioProducts.length,
      myntraProducts: myntraProducts.length,
      totalProducts: allProducts.length,
      deals: deals.length,
      durationMs: duration,
    }, 'Scan cycle complete');
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Scan cycle failed');
  } finally {
    scanRunning = false;
  }
}

/**
 * Upsert scanned products into the DB.
 * Must run before deal detection so FK constraints on active_deals are satisfied.
 */
async function upsertProducts(allProducts: NormalizedProduct[]): Promise<void> {
  const db = getDB();
  const now = Date.now();

  for (const p of allProducts) {
    const platformId = p.id.split(':')[1] ?? p.id;
    try {
      await db.insert(products).values({
        id: p.id,
        platform: p.platform,
        platformId,
        name: p.name,
        brand: p.brand,
        url: p.url,
        weightGrams: p.totalWeightGrams,
        fineness: p.fineness,
        karat: p.karat,
        isCombo: p.isCombo,
        pieceCount: p.pieceCount,
        mrp: p.mrp,
        sellingPrice: p.sellingPrice,
        offerPrice: p.couponPrice ?? null,
        couponPrice: p.couponPrice ?? null,
        effectivePrice: p.effectivePrice,
        discountPercent: p.discountPercent,
        weightSource: p.weightSource,
        puritySource: p.puritySource,
        parseWarnings: p.parseWarnings.length > 0 ? JSON.stringify(p.parseWarnings) : null,
        lastSeenAt: now,
        firstSeenAt: now,
        isActive: true,
        rating: p.rating ?? null,
        ratingCount: p.ratingCount ?? null,
      }).onConflictDoUpdate({
        target: products.id,
        set: {
          mrp: sql`excluded.mrp`,
          sellingPrice: sql`excluded.selling_price`,
          offerPrice: sql`excluded.offer_price`,
          couponPrice: sql`excluded.coupon_price`,
          effectivePrice: sql`excluded.effective_price`,
          discountPercent: sql`excluded.discount_percent`,
          lastSeenAt: sql`excluded.last_seen_at`,
          isActive: sql`1`,
          name: sql`excluded.name`,
          rating: sql`excluded.rating`,
          ratingCount: sql`excluded.rating_count`,
        },
      });
    } catch (err) {
      logger.debug({ productId: p.id, error: (err as Error).message }, 'Product upsert failed');
    }
  }

  logger.debug({ count: allProducts.length }, 'Products upserted');
}

/**
 * Refresh IBJA rates and log to history.
 */
async function refreshIBJARates(): Promise<void> {
  try {
    const rates = await fetchIBJARates();
    const db = getDB();

    await db.insert(ibjaRateHistory).values({
      date: rates.date,
      session: rates.session,
      gold999: rates.perGram[999],
      gold995: rates.perGram[995],
      gold916: rates.perGram[916],
      gold750: rates.perGram[750],
      fetchedAt: rates.fetchedAt,
    });

    // After rate refresh, run a scan to recalculate deals
    await runScanCycle();
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'IBJA rate refresh failed');
  }
}

/**
 * Start the scheduler.
 */
export function startScheduler(): void {
  const intervalMin = config.scanIntervalMinutes;

  // Product scan cycle — every N minutes
  cron.schedule(`*/${intervalMin} * * * *`, () => {
    runScanCycle();
  });

  // IBJA rate refresh — twice daily (after publish times)
  // AM rate: 12:06 PM, 12:10 PM, 12:15 PM IST (retry windows)
  cron.schedule('6,10,15 12 * * 1-5', () => {
    refreshIBJARates();
  }, { timezone: 'Asia/Kolkata' });

  // PM rate: 5:06 PM, 5:10 PM, 5:15 PM IST
  cron.schedule('6,10,15 17 * * 1-5', () => {
    refreshIBJARates();
  }, { timezone: 'Asia/Kolkata' });

  // Weekend: refresh once on Saturday morning for any late Friday updates
  cron.schedule('0 10 * * 6', () => {
    refreshIBJARates();
  }, { timezone: 'Asia/Kolkata' });

  logger.info(
    { scanInterval: `${intervalMin}min`, ibjaRefresh: '12:06/17:06 IST weekdays' },
    'Scheduler started',
  );
}
