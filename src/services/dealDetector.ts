import type {
  NormalizedProduct,
  Deal,
  PlatformOffers,
  AjioBankOffer,
  GoldRates,
  Fineness,
} from '../config/types.js';
import { logger } from '../utils/logger.js';

/**
 * Detect deals from a list of normalized products against IBJA rates.
 * Optionally factors in Ajio promo codes and bank offers.
 */
export function detectDeals(
  products: NormalizedProduct[],
  rates: GoldRates,
  offers?: PlatformOffers,
): Deal[] {
  const deals: Deal[] = [];

  for (const product of products) {
    const deal = evaluateProduct(product, rates, offers);
    if (deal) deals.push(deal);
  }

  // Sort by total savings % descending (best deals first)
  deals.sort((a, b) => b.totalSavingsPct - a.totalSavingsPct);

  return deals;
}

/**
 * Evaluate a single product for deal potential.
 * Returns a Deal if the product is priced below market value, null otherwise.
 */
function evaluateProduct(
  product: NormalizedProduct,
  rates: GoldRates,
  offers?: PlatformOffers,
): Deal | null {
  // Get IBJA rate for this product's fineness
  const ibjaRate = getRate(rates, product.fineness);
  if (ibjaRate <= 0) return null;

  // Market value = weight × IBJA per-gram rate
  const marketValue = product.totalWeightGrams * ibjaRate;
  if (marketValue <= 0) return null;

  // Base effective price (already the lowest of mrp/selling/offer/coupon)
  let finalPrice = product.effectivePrice;
  let promoSavings = 0;
  let bankOfferSavings = 0;
  let bestBankOffer: AjioBankOffer | undefined;

  // Apply Ajio promo codes and bank offers
  if (product.platform === 'ajio' && offers?.platform === 'ajio') {
    // Promo code savings
    promoSavings = calculatePromoSavings(finalPrice, offers.promos);

    // Bank offer savings (calculated on original price, not after promo)
    const bankResult = calculateBestBankOffer(product.effectivePrice, offers.bankOffers);
    bankOfferSavings = bankResult.savings;
    bestBankOffer = bankResult.offer;

    // Final price after all offers
    finalPrice = product.effectivePrice - promoSavings - bankOfferSavings;
  }

  // Total savings
  const totalSavings = marketValue - finalPrice;
  const totalSavingsPct = (totalSavings / marketValue) * 100;

  // Base savings (without promo/bank)
  const savings = marketValue - product.effectivePrice;
  const savingsPct = (savings / marketValue) * 100;

  // Is this a deal? Final price must be below market value
  if (totalSavings <= 0) return null;

  return {
    product,
    marketValue,
    effectivePrice: product.effectivePrice,
    savings,
    savingsPct,
    promoSavings,
    bestBankOffer,
    bankOfferSavings,
    finalPrice,
    totalSavings,
    totalSavingsPct,
    ibjaRate,
    ibjaSession: rates.session,
    detectedAt: Date.now(),
  };
}

/**
 * Get per-gram IBJA rate for a fineness value.
 */
function getRate(rates: GoldRates, fineness: Fineness): number {
  // Map fineness to rate key
  const keyMap: Record<number, keyof GoldRates['perGram']> = {
    999.9: 999,
    999: 999,
    995: 995,
    916: 916,
    750: 750,
    585: 585,
  };

  const key = keyMap[fineness];
  return key ? rates.perGram[key] : 0;
}

/**
 * Calculate savings from promo codes.
 * Takes the best applicable promo.
 */
function calculatePromoSavings(
  price: number,
  promos: PlatformOffers['promos'],
): number {
  let bestSavings = 0;

  for (const promo of promos) {
    if (promo.restrictedToNewUser) continue;

    // Parse the promo description to extract discount details
    // Example: "Get additional 2% off upto Rs. 2000/- on cart value of Rs. 9,999/-"
    const pctMatch = promo.description.match(/(\d+)%\s*off/i);
    const maxMatch = promo.description.match(/upto\s*Rs\.?\s*([\d,]+)/i);
    const minMatch = promo.description.match(/(?:cart value|minimum|min).*?Rs\.?\s*([\d,]+)/i);

    if (!pctMatch) continue;

    const pct = parseInt(pctMatch[1]);
    const maxCap = maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : Infinity;
    const minOrder = minMatch ? parseInt(minMatch[1].replace(/,/g, '')) : 0;

    if (price < minOrder) continue;

    const discount = Math.min(price * pct / 100, maxCap);
    bestSavings = Math.max(bestSavings, discount);
  }

  return Math.round(bestSavings);
}

/**
 * Calculate the best applicable bank offer for a given price.
 * Returns savings amount and the offer details.
 *
 * Bank offers from Ajio have:
 * - `offerAmount`: either a percentage (e.g. 12 = 12%) or a flat/cashback cap
 * - `absolute`: true = flat amount, false = percentage
 * - BUT some "cashback" offers have absolute=false with offerAmount as the max cashback cap
 *   (e.g., "Assured cashback up to ₹500" has offerAmount=500, absolute=false)
 *
 * We detect this by: if offerAmount > 50 and absolute=false, it's likely a cashback cap, not a percentage.
 * Real percentage offers are always <= 15% (typical bank discount).
 */
function calculateBestBankOffer(
  price: number,
  bankOffers: AjioBankOffer[],
): { savings: number; offer?: AjioBankOffer } {
  let bestSavings = 0;
  let bestOffer: AjioBankOffer | undefined;

  for (const offer of bankOffers) {
    if (price < offer.thresholdAmount) continue;

    let savings: number;

    if (offer.absolute) {
      // Flat amount discount
      savings = offer.offerAmount;
    } else if (offer.offerAmount > 50) {
      // offerAmount > 50 and not absolute → this is a cashback CAP, not a percentage
      // e.g., "Assured cashback up to ₹500" → offerAmount=500
      // Treat as flat cashback capped at offerAmount
      savings = offer.offerAmount;
    } else {
      // Genuine percentage discount (e.g., 5%, 10%, 12%)
      // Parse max cap from description
      const maxMatch = offer.description.match(/(?:up\s*to|upto)\s*Rs\.?\s*([\d,]+)/i);
      const maxCap = maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : Infinity;
      savings = Math.min(price * offer.offerAmount / 100, maxCap);
    }

    // Sanity: savings should never exceed 25% of price
    const maxReasonableSavings = price * 0.25;
    savings = Math.min(savings, maxReasonableSavings);

    if (savings > bestSavings) {
      bestSavings = savings;
      bestOffer = offer;
    }
  }

  return { savings: Math.round(bestSavings), offer: bestOffer };
}

/**
 * Generate a hash of current promo/offer state for change detection.
 */
export function generatePromoHash(offers: PlatformOffers): string {
  const promoCodes = offers.promos.map((p) => p.code).sort().join(',');
  const bankNames = offers.bankOffers.map((b) => `${b.bankName}:${b.offerAmount}`).sort().join(',');
  return `${promoCodes}|${bankNames}`;
}
