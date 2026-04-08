import type {
  NormalizedProduct,
  Deal,
  BankOfferResult,
  PlatformOffers,
  ProductOffers,
  AjioBankOffer,
  GoldRates,
  Fineness,
} from '../config/types.js';
import { fetchProductPDPs } from '../scrapers/ajio.js';
import { logger } from '../utils/logger.js';

/**
 * Pre-filter threshold: products priced up to this % above IBJA spot
 * are considered candidates for PDP verification.
 * e.g., 1.10 means products up to 10% above spot are checked.
 */
const CANDIDATE_THRESHOLD = 1.10;

/**
 * Detect deals using 2-phase approach:
 * Phase 1: Pre-filter — find candidates whose listing price is within 5% above IBJA spot
 * Phase 2: PDP verify — fetch real per-product offers from Ajio PDP, recalculate with actual promos & bank offers
 *
 * For Myntra products (no PDP offers), deal detection uses listing price only.
 */
export async function detectDeals(
  products: NormalizedProduct[],
  rates: GoldRates,
  offers?: PlatformOffers,
): Promise<Deal[]> {
  const deals: Deal[] = [];

  // ─── Phase 1: Pre-filter candidates ───
  const ajioCandidates: NormalizedProduct[] = [];
  const myntraProducts: NormalizedProduct[] = [];

  for (const product of products) {
    if (product.platform === 'myntra') {
      myntraProducts.push(product);
      continue;
    }

    // Ajio: check if listing price is within threshold of market value
    const ibjaRate = getRate(rates, product.fineness);
    if (ibjaRate <= 0) continue;

    const marketValue = product.totalWeightGrams * ibjaRate;
    if (marketValue <= 0) continue;

    // Price sanity check: skip if price > 1.5x spot
    const pricePerGram = product.effectivePrice / product.totalWeightGrams;
    if (pricePerGram > ibjaRate * 1.5) continue;

    // Candidate if listing price is within threshold (5% above spot)
    if (product.effectivePrice <= marketValue * CANDIDATE_THRESHOLD) {
      ajioCandidates.push(product);
    }
  }

  logger.info(
    { ajioCandidates: ajioCandidates.length, myntra: myntraProducts.length },
    'Deal detection: Phase 1 pre-filter complete',
  );

  // ─── Phase 2: Fetch PDP for Ajio candidates ───
  let pdpOffers = new Map<string, ProductOffers>();
  if (ajioCandidates.length > 0) {
    pdpOffers = await fetchProductPDPs(ajioCandidates, 5);
  }

  // Evaluate Ajio candidates with real PDP offers
  for (const product of ajioCandidates) {
    const productPDP = pdpOffers.get(product.id);
    const deal = evaluateProduct(product, rates, productPDP);
    if (deal) deals.push(deal);
  }

  // Evaluate Myntra products (no PDP/offers)
  for (const product of myntraProducts) {
    const deal = evaluateProduct(product, rates);
    if (deal) deals.push(deal);
  }

  // Sort by total savings % descending (best deals first)
  deals.sort((a, b) => b.totalSavingsPct - a.totalSavingsPct);

  logger.info({ deals: deals.length }, 'Deal detection: Phase 2 complete');

  return deals;
}

/**
 * Evaluate a single product for deal potential.
 * For Ajio: uses real per-product PDP offers (promos + bank offers).
 * For Myntra: uses listing price only.
 */
function evaluateProduct(
  product: NormalizedProduct,
  rates: GoldRates,
  productOffers?: ProductOffers | null,
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
  let appliedPromoCode: string | undefined;
  let bankOfferSavings = 0;
  let bestBankOffer: AjioBankOffer | undefined;
  let topBankOffers: BankOfferResult[] = [];

  // Apply real PDP offers for Ajio products
  if (product.platform === 'ajio' && productOffers) {
    // Promo code savings (from real PDP)
    const promoResult = calculatePromoSavings(finalPrice, productOffers.promos);
    promoSavings = promoResult.savings;
    appliedPromoCode = promoResult.promoCode;

    // Bank offer savings (calculated on original price, not after promo)
    const bankResult = calculateTopBankOffers(product.effectivePrice, productOffers.bankOffers);
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
    appliedPromoCode,
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
 * Returns savings amount and the promo code that achieved it.
 */
function calculatePromoSavings(
  price: number,
  promos: ProductOffers['promos'],
): { savings: number; promoCode?: string } {
  let bestSavings = 0;
  let bestCode: string | undefined;

  for (const promo of promos) {
    if (promo.restrictedToNewUser) continue;

    // Parse the promo description to extract discount details
    const pctMatch = promo.description.match(/(\d+)%\s*off/i);
    const maxMatch = promo.description.match(/upto\s*Rs\.?\s*([\d,]+)/i);
    const minMatch = promo.description.match(/(?:cart value|minimum|min).*?Rs\.?\s*([\d,]+)/i);

    if (!pctMatch) continue;

    const pct = parseInt(pctMatch[1]);
    const maxCap = maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : Infinity;
    const minOrder = minMatch ? parseInt(minMatch[1].replace(/,/g, '')) : 0;

    if (price < minOrder) continue;

    const discount = Math.min(price * pct / 100, maxCap);
    if (discount > bestSavings) {
      bestSavings = discount;
      bestCode = promo.code;
    }
  }

  return { savings: Math.round(bestSavings), promoCode: bestCode };
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
