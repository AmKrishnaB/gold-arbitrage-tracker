/**
 * Debug PDP codes — fetch a few products and check their codes vs PDP
 */
import { fetchAllAjioProducts } from './scrapers/ajio.js';
import axios from 'axios';

const PDP_BASE_URL = 'https://pdpaggregator-edge.services.ajio.com/aggregator/pdp';
const PDP_HEADERS = {
  'Requestid': 'ProductDetails',
  'Accept': 'application/json',
  'User-Agent': 'Ajio/9.31.1 (Android 15)',
  'Client_type': 'Android',
  'Client_version': '9.31.1',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function debug() {
  const products = await fetchAllAjioProducts();
  
  // Get a sample of products
  const samples = products.slice(0, 10);
  
  console.log('\n═══ PDP Code Debug ═══\n');
  
  for (const p of samples) {
    const rawCode = p.id.replace('ajio:', '');
    
    // Try different code formats
    const variants = [
      rawCode,
      `${rawCode}_multi`,
      rawCode.replace(/_.*$/, ''),
    ];
    
    console.log(`Product: ${p.name.slice(0, 50)}`);
    console.log(`  ID: ${p.id}`);
    console.log(`  URL: ${p.url}`);
    
    // Extract code from URL
    const urlMatch = p.url.match(/\/p\/([^/?]+)/);
    const urlCode = urlMatch ? urlMatch[1] : null;
    if (urlCode) {
      console.log(`  URL-extracted code: ${urlCode}`);
      if (!variants.includes(urlCode)) variants.push(urlCode);
    }
    
    for (const code of [...new Set(variants)]) {
      try {
        const url = `${PDP_BASE_URL}/${code}?sortOptionsByColor=true&client_type=Android&client_version=9.31.1&isNewUser=true&tagVersionTwo=false&applyExperiment=false&fields=FULL`;
        const res = await axios.get(url, { headers: PDP_HEADERS, timeout: 10000 });
        const promos = res.data.potentialPromotions?.length ?? 0;
        const bank = res.data.prepaidOffers?.length ?? 0;
        console.log(`  ✅ ${code} → promos=${promos}, bankOffers=${bank}`);
        break; // Found working code
      } catch (err: any) {
        console.log(`  ❌ ${code} → ${err.response?.status ?? err.message}`);
      }
    }
    console.log();
  }
}

debug().catch(console.error);
