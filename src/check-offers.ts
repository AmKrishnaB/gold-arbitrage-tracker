/**
 * Quick check — show bank offer descriptions from a PDP
 */
import axios from 'axios';

const PDP_BASE_URL = 'https://pdpaggregator-edge.services.ajio.com/aggregator/pdp';
const PDP_HEADERS = {
  'Requestid': 'ProductDetails',
  'Accept': 'application/json',
  'User-Agent': 'Ajio/9.31.1 (Android 15)',
  'Client_type': 'Android',
  'Client_version': '9.31.1',
};

async function check() {
  const res = await axios.get(`${PDP_BASE_URL}/600540763?fields=FULL&client_type=Android`, { headers: PDP_HEADERS });
  const offers = res.data.prepaidOffers ?? [];
  console.log(`Total offers: ${offers.length}\n`);
  for (const o of offers) {
    const instruments = o.eligiblePaymentInstruments?.join('/') ?? '';
    console.log(`Bank: ${o.bankName}`);
    console.log(`Desc: ${o.description}`);
    console.log(`Amount: ${o.offerAmount} | Threshold: ${o.thresholdAmount} | Absolute: ${o.absolute}`);
    console.log(`Instruments: ${instruments}`);
    console.log('---');
  }
}
check().catch(console.error);
