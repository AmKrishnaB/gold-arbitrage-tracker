import type {
  NormalizedProduct,
  Deal,
  BankOfferResult,
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
  let topBankOffers: BankOfferResult[] = [];

  // Apply Ajio promo codes and bank offers
  if (product.platform === 'ajio' && offers?.platform === 'ajio') {
    // Promo code savings
    promoSavings = calculatePromoSavings(finalPrice, offers.promos);

    // Bank offer savings (calculated on original price, not after promo)
    const bankResult = calculateTopBankOffers(product.effectivePrice, offers.bankOffers);
    topBankOffers = bankResult;
    if (bankResult.length > 0) {
      bestBankOffer = bankResult[0].offer;
      bankOfferSavings = bankResult[0].savings;
    }

    // Final price after all offers (use best bank offer only)
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
    topBankOffers,
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
 * Calculate all applicable bank offers for a given price, sorted by savings.
 * Returns top offers (up to 3) with their calculated savings.
 *
 * Uses enriched offer data:
 * - Skips gold-excluded offers (from T&C analysis)
 * - Skips offers needing admin review (conservative)
 * - Uses parsedType/parsedPct/parsedCap from description parsing
 */
function calculateTopBankOffers(
  price: number,
  bankOffers: AjioBankOffer[],
): BankOfferResult[] {
  const results: BankOfferResult[] = [];

  for (const offer of bankOffers) {
    // Skip gold-excluded offers
    if (offer.excludesGold) continue;

    // Skip offers pending admin review (conservative)
    if (offer.needsReview) continue;

    // Skip if price below threshold
    if (price < offer.thresholdAmount) continue;

    let savings: number;

    switch (offer.parsedType) {
      case 'flat':
        savings = offer.parsedCap ?? offer.offerAmount;
        break;

      case 'cashback_cap':
        savings = offer.parsedCap ?? offer.offerAmount;
        break;

      case 'percent': {
        const pct = offer.parsedPct ?? offer.offerAmount;
        const cap = offer.parsedCap ?? 1500; // Safe default if no cap found
        savings = Math.min(price * pct / 100, cap);
        break;
      }

      default:
        // Unknown type — treat offerAmount as flat cap (conservative)
        savings = Math.min(offer.offerAmount, 500);
        break;
    }

    // Sanity: savings should never exceed 25% of price
    savings = Math.min(savings, price * 0.25);

    if (savings > 0) {
      results.push({ offer, savings: Math.round(savings) });
    }
  }

  // Sort by savings descending
  results.sort((a, b) => b.savings - a.savings);

  // Deduplicate by bankName (keep highest savings per bank)
  const seenBanks = new Set<string>();
  const deduped: BankOfferResult[] = [];
  for (const r of results) {
    if (!seenBanks.has(r.offer.bankName)) {
      seenBanks.add(r.offer.bankName);
      deduped.push(r);
    }
  }

  return deduped.slice(0, 3);
}

/**
 * Generate a hash of current promo/offer state for change detection.
 */
export function generatePromoHash(offers: PlatformOffers): string {
  const promoCodes = offers.promos.map((p) => p.code).sort().join(',');
  const bankNames = offers.bankOffers.map((b) => `${b.bankName}:${b.offerAmount}`).sort().join(',');
  return `${promoCodes}|${bankNames}`;
}
