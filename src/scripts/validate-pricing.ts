/**
 * Focused validation: Ajio only + dealDetector with the new
 * listedPrice / promoDiscount / bankDiscount fields.
 *
 * Run: npx tsx src/scripts/validate-pricing.ts
 */

import { fetchIBJARates } from '../services/goldRate.js';
import { fetchAllAjioProducts } from '../scrapers/ajio.js';
import { detectDeals } from '../services/dealDetector.js';
import { formatDealMessage } from '../bot/templates.js';
import type { GoldRates } from '../config/types.js';

async function main() {
  console.log('=== Ajio Pricing Validation ===\n');

  let rates: GoldRates;
  try {
    rates = await fetchIBJARates();
  } catch {
    rates = {
      date: new Date().toISOString().slice(0, 10),
      session: 'PM',
      perGram: { 999: 14890, 995: 14830, 916: 13639, 750: 11167, 585: 8710 },
      fetchedAt: Date.now(),
    };
  }
  console.log(`IBJA 999: Rs ${rates.perGram[999]}/gm\n`);

  console.log('Fetching Ajio products...');
  const products = await fetchAllAjioProducts();
  console.log(`Parsed: ${products.length} products\n`);

  const ajio = products.filter((p) => p.platform === 'ajio');

  const withPromo = ajio.filter((p) => (p.promoDiscount ?? 0) > 0);
  console.log(`With promoDiscount > 0: ${withPromo.length}`);

  const mismatches = ajio.filter(
    (p) => Math.abs((p.listedPrice ?? -1) - p.effectivePrice) > 0.5,
  );
  console.log(`Listed vs effective mismatches: ${mismatches.length}`);

  console.log('\n--- Sample products ---');
  for (const p of ajio.slice(0, 3)) {
    console.log({
      name: p.name.slice(0, 50),
      mrp: p.mrp,
      sellingPrice: p.sellingPrice,
      offerPrice: p.offerPrice,
      couponPrice: p.couponPrice,
      effectivePrice: p.effectivePrice,
      listedPrice: p.listedPrice,
      promoDiscount: p.promoDiscount,
      bankDiscount: p.bankDiscount,
    });
  }

  console.log('\nRunning dealDetector on first 30 Ajio products...');
  const deals = await detectDeals(ajio.slice(0, 30), rates);
  console.log(`Deals: ${deals.length}`);

  if (deals.length > 0) {
    const d = deals[0];
    console.log('\n--- First deal breakdown ---');
    console.log({
      listedPrice: d.listedPrice,
      promoDiscount: d.promoDiscount,
      bankDiscount: d.bankDiscount,
      finalPrice: d.finalPrice,
      marketValue: d.marketValue,
      totalSavings: d.totalSavings,
      pct: d.totalSavingsPct.toFixed(2),
    });
    console.log('\n--- Formatted message ---');
    console.log(formatDealMessage(d, d.product.url, 'active'));
  }

  console.log('\n=== Validation complete ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
