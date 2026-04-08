import { fetchAllAjioProducts } from './src/scrapers/ajio.js';

async function main() {
  const products = await fetchAllAjioProducts();
  
  // Find vedhanis and other ring-category items
  const vedhanis = products.filter(p => p.name.toLowerCase().includes('vedhan'));
  
  console.log(`\nTotal products: ${products.length}`);
  console.log(`Vedhanis found: ${vedhanis.length}\n`);
  
  if (vedhanis.length === 0) {
    console.log('❌ NO VEDHANIS FOUND - rings category scrape may have failed');
  } else {
    console.log('✅ Vedhanis from rings category:');
    for (const p of vedhanis) {
      console.log(`  ${p.id} | ${p.brand} | ${p.name}`);
      console.log(`    Weight: ${p.totalWeightGrams}g | Purity: ${p.fineness} (${p.karat}K)`);
      console.log(`    Price: ₹${Math.round(p.effectivePrice)} | URL: ${p.url}`);
      console.log();
    }
  }

  // Also check if any other new products came from 24K all-categories query
  // that wouldn't be in the curated listing
  const brands = new Map<string, number>();
  for (const p of products) {
    brands.set(p.brand, (brands.get(p.brand) || 0) + 1);
  }
  console.log('Brand breakdown:');
  const sorted = [...brands.entries()].sort((a, b) => b[1] - a[1]);
  for (const [brand, count] of sorted) {
    console.log(`  ${brand}: ${count}`);
  }
}

main().catch(console.error);
