/**
 * Quick test — Ajio only + PDP-verified deal detection
 * Shows what /deals would return
 */

import { fetchIBJARates } from './services/goldRate.js';
import { fetchAllAjioProducts } from './scrapers/ajio.js';
import { detectDeals } from './services/dealDetector.js';
import { formatDealMessage, formatDealsSummary, DEALS_PAGE_SIZE } from './bot/templates.js';
import type { GoldRates } from './config/types.js';

async function quickTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  QUICK TEST — Ajio + PDP-verified deals');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. IBJA rates
  console.log('📊 Fetching IBJA rates...');
  let rates: GoldRates;
  try {
    rates = await fetchIBJARates();
  } catch {
    console.log('⚠️ IBJA unavailable, using fallback');
    rates = {
      date: new Date().toISOString().slice(0, 10),
      session: 'PM',
      perGram: { 999: 15207, 995: 15146, 916: 13929, 750: 11405, 585: 8710 },
      fetchedAt: Date.now(),
    };
  }
  console.log(`  24K(999): ₹${rates.perGram[999]}/gm | 22K(916): ₹${rates.perGram[916]}/gm\n`);

  // 2. Fetch Ajio products
  console.log('🔍 Fetching Ajio products...');
  const products = await fetchAllAjioProducts();
  console.log(`  ${products.length} products parsed\n`);

  // 3. Pre-filter stats
  const candidateThreshold = 1.05;
  const candidates = products.filter((p) => {
    const key = p.fineness >= 999 ? 999 : p.fineness === 995 ? 995 : p.fineness === 916 ? 916 : 750;
    const rate = rates.perGram[key as keyof typeof rates.perGram] || 0;
    const marketValue = p.totalWeightGrams * rate;
    return p.effectivePrice <= marketValue * candidateThreshold;
  });
  console.log(`📋 Phase 1: ${candidates.length} candidates within 5% of IBJA spot`);
  console.log(`   (out of ${products.length} total products)\n`);

  // 4. Detect deals (Phase 2: PDP verification)
  console.log('💰 Running deal detection with PDP verification...\n');
  const deals = await detectDeals(products, rates);

  // 5. Show results
  if (deals.length === 0) {
    console.log('📋 No deals found below IBJA market value.\n');
  } else {
    console.log(`🔥 ${deals.length} DEAL(S) FOUND!\n`);
    console.log('━'.repeat(65));

    for (const deal of deals) {
      const hasPDP = deal.promoSavings > 0 || deal.topBankOffers.length > 0;
      if (hasPDP) {
        const offers = [];
        if (deal.promoSavings > 0) offers.push(`promo: -₹${deal.promoSavings}${deal.appliedPromoCode ? ` (${deal.appliedPromoCode})` : ''}`);
        if (deal.topBankOffers.length > 0) offers.push(`bank: ${deal.topBankOffers.map(o => `${o.offer.bankName} -₹${o.savings}`).join(', ')}`);
        console.log(`  [PDP verified: ${offers.join(' | ')}]`);
      } else {
        console.log('  [Base price below spot — no PDP offers needed]');
      }
      console.log(formatDealMessage(deal, deal.product.url));
      console.log('━'.repeat(65));
      console.log();
    }
  }

  // 6. Show what /deals would display (all pages)
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  /deals COMMAND OUTPUT (paginated)');
  console.log('═══════════════════════════════════════════════════\n');
  const totalPages = Math.ceil(deals.length / DEALS_PAGE_SIZE);
  for (let p = 0; p < totalPages; p++) {
    console.log(formatDealsSummary(deals, p));
    if (p < totalPages - 1) {
      console.log(`  [◀️ Prev]  [${p + 1} / ${totalPages}]  [Next ▶️]\n`);
    } else {
      console.log(`  [◀️ Prev]  [${p + 1} / ${totalPages}]\n`);
    }
  }

  // 7. Near-deal products (within 5% above IBJA but not a deal)
  console.log('\n\n═══════════════════════════════════════════════════');
  console.log('  NEAR-DEAL PRODUCTS (within 5% above IBJA)');
  console.log('═══════════════════════════════════════════════════\n');

  const dealProductIds = new Set(deals.map(d => d.product.id));
  const nearDeals = candidates.filter(p => !dealProductIds.has(p.id));
  
  if (nearDeals.length === 0) {
    console.log('  None — all candidates became deals!\n');
  } else {
    for (const p of nearDeals.slice(0, 15)) {
      const key = p.fineness >= 999 ? 999 : p.fineness === 995 ? 995 : p.fineness === 916 ? 916 : 750;
      const rate = rates.perGram[key as keyof typeof rates.perGram] || 0;
      const mv = p.totalWeightGrams * rate;
      const premium = ((p.effectivePrice - mv) / mv * 100).toFixed(1);
      console.log(`  ${p.brand.slice(0, 20).padEnd(22)} ${p.totalWeightGrams}g ${p.fineness}  ₹${Math.round(p.effectivePrice).toLocaleString('en-IN').padEnd(8)} vs ₹${Math.round(mv).toLocaleString('en-IN').padEnd(8)}  +${premium}% above`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════');
}

quickTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
