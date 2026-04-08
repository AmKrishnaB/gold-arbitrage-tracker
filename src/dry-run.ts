/**
 * Dry-run script — tests the full pipeline against live APIs
 * WITHOUT sending any Telegram notifications.
 *
 * Usage: npm run dry-run
 */

import { fetchIBJARates, getCachedRates } from './services/goldRate.js';
import { fetchAllAjioProducts } from './scrapers/ajio.js';
import { fetchAllMyntraProducts } from './scrapers/myntra.js';
import { detectDeals } from './services/dealDetector.js';
import { formatDealMessage, formatGoldRateMessage } from './bot/templates.js';
import { logger } from './utils/logger.js';
import type { NormalizedProduct } from './config/types.js';

async function dryRun() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  GOLD ARBITRAGE DEAL TRACKER — DRY RUN');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Step 1: Fetch IBJA Rates ───
  console.log('📊 Step 1: Fetching IBJA gold rates...');
  let rates: import('./config/types.js').GoldRates;
  try {
    rates = await fetchIBJARates();
  } catch (err) {
    // IBJA rates not available (before market hours) — use last known rates for testing
    console.log('⚠️ IBJA API unavailable, using fallback rates for testing');
    rates = {
      date: new Date().toISOString().slice(0, 10),
      session: 'PM',
      perGram: { 999: 14890, 995: 14830, 916: 13639, 750: 11167, 585: 8710 },
      fetchedAt: Date.now(),
    };
  }
  console.log(formatGoldRateMessage(rates.date, rates.session, rates.perGram));
  console.log();

  // ─── Step 2: Fetch Products ───
  console.log('🔍 Step 2: Fetching products from both platforms...\n');

  const [ajioProducts, myntraProducts] = await Promise.all([
    fetchAllAjioProducts().catch((err) => {
      console.log(`❌ Ajio failed: ${err.message}`);
      return [] as NormalizedProduct[];
    }),
    fetchAllMyntraProducts().catch((err) => {
      console.log(`❌ Myntra failed: ${err.message}`);
      return [] as NormalizedProduct[];
    }),
  ]);

  const allProducts = [...ajioProducts, ...myntraProducts];

  console.log(`📦 Ajio:   ${ajioProducts.length} products parsed`);
  console.log(`📦 Myntra: ${myntraProducts.length} products parsed`);
  console.log(`📦 Total:  ${allProducts.length} products\n`);

  // ─── Step 3: Product Breakdown ───
  console.log('📋 Product Breakdown:');

  const combos = allProducts.filter((p) => p.isCombo);
  const by999 = allProducts.filter((p) => p.fineness >= 999);
  const by916 = allProducts.filter((p) => p.fineness === 916);
  const byWarning = allProducts.filter((p) => p.parseWarnings.length > 0);

  console.log(`  24K (999/999.9): ${by999.length}`);
  console.log(`  22K (916):       ${by916.length}`);
  console.log(`  Combos:          ${combos.length}`);
  console.log(`  With warnings:   ${byWarning.length}`);
  console.log();

  // Show parse warnings
  if (byWarning.length > 0) {
    console.log('⚠️ Products with parse warnings:');
    for (const p of byWarning.slice(0, 10)) {
      console.log(`  ${p.id}: ${p.name}`);
      for (const w of p.parseWarnings) {
        console.log(`    → ${w}`);
      }
    }
    console.log();
  }

  // ─── Step 4: Detect Deals (with PDP verification) ───
  console.log('💰 Step 4: Running deal detection (pre-filter → PDP verify)...\n');

  const deals = await detectDeals(allProducts, rates);

  if (deals.length === 0) {
    console.log('📋 No deals found (all products are above IBJA market value)\n');
  } else {
    console.log(`🔥 ${deals.length} DEAL(S) FOUND! (showing top 20)\n`);
    for (const deal of deals.slice(0, 20)) {
      console.log('─'.repeat(60));
      // Show PDP-verified offers info
      if (deal.promoSavings > 0 || deal.topBankOffers.length > 0) {
        console.log(`  [PDP verified: promo -₹${deal.promoSavings}${deal.appliedPromoCode ? ` (${deal.appliedPromoCode})` : ''}, bank offers: ${deal.topBankOffers.length}]`);
      }
      console.log(formatDealMessage(deal, deal.product.url));
      console.log();
    }
  }

  // ─── Step 5: Closest to Deal ───
  console.log('📊 Step 5: Top 10 Closest to Market Value:\n');

  // Calculate premium for each product
  const premiums = allProducts
    .map((p) => {
      const key = p.fineness >= 999 ? 999 : p.fineness === 995 ? 995 : p.fineness === 916 ? 916 : 750;
      const ratePerGram = rates.perGram[key as keyof typeof rates.perGram] || 0;
      const marketValue = p.totalWeightGrams * ratePerGram;
      const premium = ((p.effectivePrice - marketValue) / marketValue) * 100;
      return { product: p, marketValue, premium, ratePerGram };
    })
    .filter((x) => x.marketValue > 0)
    .sort((a, b) => a.premium - b.premium);

  console.log(
    'Platform'.padEnd(8) +
    'Brand'.padEnd(22) +
    'Weight'.padEnd(8) +
    'Purity'.padEnd(8) +
    'Price'.padEnd(12) +
    'Market'.padEnd(12) +
    'Premium'.padEnd(10),
  );
  console.log('─'.repeat(80));

  for (const item of premiums.slice(0, 10)) {
    const p = item.product;
    const platform = p.platform === 'ajio' ? 'Ajio' : 'Myntra';
    console.log(
      platform.padEnd(8) +
      p.brand.slice(0, 20).padEnd(22) +
      `${p.totalWeightGrams}g`.padEnd(8) +
      `${p.fineness}`.padEnd(8) +
      `₹${Math.round(p.effectivePrice).toLocaleString('en-IN')}`.padEnd(12) +
      `₹${Math.round(item.marketValue).toLocaleString('en-IN')}`.padEnd(12) +
      `${item.premium.toFixed(1)}%`,
    );
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DRY RUN COMPLETE');
  console.log('═══════════════════════════════════════════════════');
}

dryRun().catch((err) => {
  console.error('Dry run failed:', err);
  process.exit(1);
});
