/**
 * Dry-run script — tests the full pipeline against live APIs
 * WITHOUT sending any Telegram notifications.
 *
 * Usage: npm run dry-run
 */

import { fetchIBJARates, getCachedRates } from './services/goldRate.js';
import { fetchAllAjioProducts } from './scrapers/ajio.js';
import { fetchAllMyntraProducts } from './scrapers/myntra.js';
import { fetchAjioOffers } from './scrapers/ajio.js';
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

  // ─── Step 4: Fetch Ajio Offers ───
  console.log('🎫 Step 4: Fetching Ajio promo/bank offers...');
  const offers = await fetchAjioOffers();
  console.log(`  Promo codes: ${offers.promos.length}`);
  for (const p of offers.promos) {
    console.log(`    ${p.code}: ${p.description.slice(0, 80)}`);
  }
  console.log(`  Bank offers: ${offers.bankOffers.length}`);

  // Show enriched bank offer breakdown
  const goldOk = offers.bankOffers.filter((o) => !o.excludesGold && !o.needsReview);
  const goldExcluded = offers.bankOffers.filter((o) => o.excludesGold);
  const needsReview = offers.bankOffers.filter((o) => o.needsReview);

  console.log(`    Gold-applicable: ${goldOk.length}`);
  console.log(`    Gold-excluded:   ${goldExcluded.length}`);
  console.log(`    Needs review:    ${needsReview.length}`);

  if (goldExcluded.length > 0) {
    console.log('  🚫 Gold-excluded offers:');
    for (const o of goldExcluded) {
      console.log(`    - ${o.bankName} (${o.parsedType}, cap=${o.parsedCap})`);
    }
  }

  if (needsReview.length > 0) {
    console.log('  ⚠️ Needs review:');
    for (const o of needsReview) {
      console.log(`    - ${o.bankName}: ${o.description.slice(0, 60)} | tncUrl=${o.tncUrl ?? 'none'}`);
    }
  }

  if (goldOk.length > 0) {
    console.log('  ✅ Gold-applicable offers:');
    for (const o of goldOk) {
      const capStr = o.parsedCap !== null ? `cap=₹${o.parsedCap}` : 'no cap';
      const pctStr = o.parsedPct !== null ? `${o.parsedPct}%` : '';
      console.log(`    - ${o.bankName}: ${o.parsedType} ${pctStr} ${capStr} | ${o.eligiblePaymentInstruments.join(',')}`);
    }
  }
  console.log();

  // ─── Step 5: Detect Deals ───
  console.log('💰 Step 5: Running deal detection...\n');

  const deals = detectDeals(allProducts, rates, offers);

  if (deals.length === 0) {
    console.log('📋 No deals found (all products are above IBJA market value)\n');
  } else {
    console.log(`🔥 ${deals.length} DEAL(S) FOUND! (showing top 50)\n`);
    for (const deal of deals.slice(0, 50)) {
      console.log('─'.repeat(60));
      console.log(formatDealMessage(deal, deal.product.url));
      console.log();
    }
  }

  // ─── Step 6: Closest to Deal ───
  console.log('📊 Step 6: Top 10 Closest to Market Value:\n');

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

  // With Ajio offers applied
  if (offers.promos.length > 0 || offers.bankOffers.length > 0) {
    console.log('\n📊 Top 10 After Ajio Promo + Best Bank Offer:\n');

    const ajioWithOffers = premiums
      .filter((x) => x.product.platform === 'ajio')
      .map((x) => {
        const promoSavings = calculateQuickPromo(x.product.effectivePrice, offers);
        const bankSavings = calculateQuickBank(x.product.effectivePrice, offers);
        const finalPrice = x.product.effectivePrice - promoSavings - bankSavings;
        const finalPremium = ((finalPrice - x.marketValue) / x.marketValue) * 100;
        return { ...x, promoSavings, bankSavings, finalPrice, finalPremium };
      })
      .sort((a, b) => a.finalPremium - b.finalPremium);

    console.log(
      'Brand'.padEnd(22) +
      'Weight'.padEnd(8) +
      'Base'.padEnd(12) +
      'Promo'.padEnd(10) +
      'Bank'.padEnd(10) +
      'Final'.padEnd(12) +
      'Market'.padEnd(12) +
      'Premium',
    );
    console.log('─'.repeat(96));

    for (const item of ajioWithOffers.slice(0, 10)) {
      const p = item.product;
      console.log(
        p.brand.slice(0, 20).padEnd(22) +
        `${p.totalWeightGrams}g`.padEnd(8) +
        `₹${Math.round(p.effectivePrice).toLocaleString('en-IN')}`.padEnd(12) +
        `-₹${item.promoSavings}`.padEnd(10) +
        `-₹${item.bankSavings}`.padEnd(10) +
        `₹${Math.round(item.finalPrice).toLocaleString('en-IN')}`.padEnd(12) +
        `₹${Math.round(item.marketValue).toLocaleString('en-IN')}`.padEnd(12) +
        `${item.finalPremium.toFixed(1)}%${item.finalPremium <= 0 ? ' ✅ DEAL!' : ''}`,
      );
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DRY RUN COMPLETE');
  console.log('═══════════════════════════════════════════════════');
}

// Quick promo calc for dry run display
function calculateQuickPromo(price: number, offers: { promos: Array<{ description: string; restrictedToNewUser: boolean }> }): number {
  for (const p of offers.promos) {
    if (p.restrictedToNewUser) continue;
    const pctMatch = p.description.match(/(\d+)%\s*off/i);
    const maxMatch = p.description.match(/upto\s*Rs\.?\s*([\d,]+)/i);
    const minMatch = p.description.match(/(?:cart value|minimum).*?Rs\.?\s*([\d,]+)/i);
    if (!pctMatch) continue;
    const pct = parseInt(pctMatch[1]);
    const maxCap = maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : Infinity;
    const minOrder = minMatch ? parseInt(minMatch[1].replace(/,/g, '')) : 0;
    if (price >= minOrder) return Math.min(Math.round(price * pct / 100), maxCap);
  }
  return 0;
}

function calculateQuickBank(price: number, offers: { bankOffers: Array<{ offerAmount: number; thresholdAmount: number; absolute: boolean; description: string; parsedType: string; parsedPct: number | null; parsedCap: number | null; excludesGold: boolean; needsReview: boolean }> }): number {
  let best = 0;
  for (const o of offers.bankOffers) {
    if (o.excludesGold || o.needsReview) continue;
    if (price < o.thresholdAmount) continue;
    let savings: number;
    switch (o.parsedType) {
      case 'flat':
        savings = o.parsedCap ?? o.offerAmount;
        break;
      case 'cashback_cap':
        savings = o.parsedCap ?? o.offerAmount;
        break;
      case 'percent': {
        const pct = o.parsedPct ?? o.offerAmount;
        const cap = o.parsedCap ?? 1500;
        savings = Math.min(price * pct / 100, cap);
        break;
      }
      default:
        savings = Math.min(o.offerAmount, 500);
        break;
    }
    savings = Math.min(savings, price * 0.25);
    best = Math.max(best, savings);
  }
  return Math.round(best);
}

dryRun().catch((err) => {
  console.error('Dry run failed:', err);
  process.exit(1);
});
