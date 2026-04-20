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
 * Phase 1: Pre-filter — find candidates whose listing price is within CANDIDATE_THRESHOLD
 *          above IBJA spot. PDP is only fetched for these, NOT for all ~hundreds of products.
 * Phase 2: PDP verify — fetch real per-product offers from Ajio PDP, recalculate with
 *          actual promos & bank offers.
 *
 * NO STATIC FALLBACK for Ajio: if the PDP fetch fails for a candidate we SKIP that product
 * entirely (logged as a warning). Per user requirement: strict accuracy over coverage.
 * The platform-wide `offers` parameter (fetched via sentinel-cart) is retained for
 * observability/logging only and is NOT used to synthesize deals.
 *
 * For Myntra products (no PDP offers scraped), deal detection uses listing price only.
 */
export async function detectDeals(
  products: NormalizedProduct[],
  rates: GoldRates,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _platformOffers?: PlatformOffers,
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

    // Candidate if listing price is within threshold
    if (product.effectivePrice <= marketValue * CANDIDATE_THRESHOLD) {
      ajioCandidates.push(product);
    }
  }

  logger.info(
    { ajioCandidates: ajioCandidates.length, myntra: myntraProducts.length },
    'Deal detection: Phase 1 pre-filter complete',
  );

  // ─── Phase 2: Fetch PDP for Ajio candidates ───
  // Cache per-product offers in a Map for the duration of this scan so we never
  // hit the same PDP twice. Concurrency=5 with inter-batch delay is enforced
  // inside fetchProductPDPs (see src/scrapers/ajio.ts).
  let pdpOffers = new Map<string, ProductOffers>();
  if (ajioCandidates.length > 0) {
    pdpOffers = await fetchProductPDPs(ajioCandidates, 5);
  }

  let ajioSkippedNoPDP = 0;
  for (const product of ajioCandidates) {
    const productPDP = pdpOffers.get(product.id);
    if (!productPDP) {
      // STRICT: no static fallback — skip this product with a warning.
      ajioSkippedNoPDP += 1;
      logger.warn(
        { productId: product.id, url: product.url },
        'Ajio candidate skipped: PDP offer fetch failed (no static fallback)',
      );
      continue;
    }
    const deal = evaluateAjioProduct(product, rates, productPDP);
    if (deal) deals.push(deal);
  }

  if (ajioSkippedNoPDP > 0) {
    logger.warn(
      { skipped: ajioSkippedNoPDP, total: ajioCandidates.length },
      'Ajio candidates skipped due to PDP fetch failure',
    );
  }

  // Evaluate Myntra products (listing-only, no PDP/offers)
  for (const product of myntraProducts) {
    const deal = evaluateMyntraProduct(product, rates);
    if (deal) deals.push(deal);
  }

  // Sort by total savings % descending (best deals first)
  deals.sort((a, b) => b.totalSavingsPct - a.totalSavingsPct);

  logger.info({ deals: deals.length }, 'Deal detection: Phase 2 complete');

  return deals;
}

/**
 * Ajio deal evaluation using real PDP offers.
 *
 * Pricing model:
 *   listedPrice   = product.listedPrice (pre-cart-promo listed price; Ajio raw.price.value)
 *   promoDiscount = max(product.promoDiscount ?? 0, PDP-promo savings against listedPrice)
 *   bankDiscount  = best applicable PDP bank offer against listedPrice
 *
 * Stacking: promo and bank offers generally do NOT stack on Ajio. We apply the
 * BETTER of the two (max) unless a PDP offer description explicitly opts in
 * (see shouldStack). Default behaviour: no stacking.
 *
 *   finalPrice = listedPrice - (stack ? promo + bank : max(promo, bank))
 */
function evaluateAjioProduct(
  product: NormalizedProduct,
  rates: GoldRates,
  productOffers: ProductOffers,
): Deal | null {
  const ibjaRate = getRate(rates, product.fineness);
  if (ibjaRate <= 0) return null;

  const marketValue = product.totalWeightGrams * ibjaRate;
  if (marketValue <= 0) return null;

  const listedPrice = product.listedPrice ?? product.effectivePrice;

  // Promo: start from listing-derived discount, upgrade if PDP reveals a bigger promo.
  const listingPromo = product.promoDiscount ?? 0;
  const pdpPromo = calculatePromoSavings(listedPrice, productOffers.promos);
  let promoDiscount = Math.max(listingPromo, pdpPromo.savings);
  const appliedPromoCode = pdpPromo.savings >= listingPromo ? pdpPromo.promoCode : undefined;

  // Bank: best PDP bank offer evaluated against listedPrice (the true pre-discount price).
  const topBankOffers = calculateTopBankOffers(listedPrice, productOffers.bankOffers);
  const bestBankOffer = topBankOffers[0]?.offer;
  let bankDiscount = topBankOffers[0]?.savings ?? 0;

  // Stacking decision: only stack when an explicit signal says so.
  const stack = shouldStack(productOffers);
  const offerDiscount = stack
    ? promoDiscount + bankDiscount
    : Math.max(promoDiscount, bankDiscount);

  // When not stacking we still report BOTH values for transparency, but also zero
  // out the one that didn't "win" so the template math is unambiguous.
  if (!stack) {
    if (bankDiscount >= promoDiscount) {
      promoDiscount = 0;
    } else {
      bankDiscount = 0;
    }
  }

  const finalPrice = Math.max(0, listedPrice - offerDiscount);

  // Total savings vs spot market value
  const totalSavings = marketValue - finalPrice;
  const totalSavingsPct = (totalSavings / marketValue) * 100;

  // Base savings = listing-price-vs-spot (pre-offer)
  const savings = marketValue - listedPrice;
  const savingsPct = (savings / marketValue) * 100;

  if (totalSavings <= 0) return null;

  // Persist the bank discount back onto the product for downstream DB write.
  product.bankDiscount = bankDiscount;

  return {
    product,
    marketValue,
    effectivePrice: product.effectivePrice,
    savings,
    savingsPct,
    // Legacy fields mirror the new three-field values (kept for message-format back-compat).
    promoSavings: promoDiscount,
    appliedPromoCode,
    bestBankOffer,
    bankOfferSavings: bankDiscount,
    topBankOffers,
    listedPrice,
    promoDiscount,
    bankDiscount,
    finalPrice,
    totalSavings,
    totalSavingsPct,
    ibjaRate,
    ibjaSession: rates.session,
    detectedAt: Date.now(),
  };
}

/**
 * Myntra deal evaluation using listing price only.
 * No PDP scrape today — see src/scrapers/myntra.ts TODO.
 */
function evaluateMyntraProduct(product: NormalizedProduct, rates: GoldRates): Deal | null {
  const ibjaRate = getRate(rates, product.fineness);
  if (ibjaRate <= 0) return null;

  const marketValue = product.totalWeightGrams * ibjaRate;
  if (marketValue <= 0) return null;

  const listedPrice = product.listedPrice ?? product.sellingPrice;
  const promoDiscount = product.promoDiscount ?? 0;
  const bankDiscount = 0;

  const finalPrice = Math.max(0, listedPrice - Math.max(promoDiscount, bankDiscount));

  const totalSavings = marketValue - finalPrice;
  const totalSavingsPct = (totalSavings / marketValue) * 100;
  const savings = marketValue - listedPrice;
  const savingsPct = (savings / marketValue) * 100;

  if (totalSavings <= 0) return null;

  return {
    product,
    marketValue,
    effectivePrice: product.effectivePrice,
    savings,
    savingsPct,
    promoSavings: promoDiscount,
    appliedPromoCode: undefined,
    bestBankOffer: undefined,
    bankOfferSavings: bankDiscount,
    topBankOffers: [],
    listedPrice,
    promoDiscount,
    bankDiscount,
    finalPrice,
    totalSavings,
    totalSavingsPct,
    ibjaRate,
    ibjaSession: rates.session,
    detectedAt: Date.now(),
  };
}

/**
 * Decide whether to stack promo + bank for this product.
 * Ajio's default is that cart-level promos and bank offers do NOT stack on
 * already-discounted coin/bar items. Only stack when a PDP offer description
 * explicitly opts in ("on already discounted" / "stackable" wording).
 */
function shouldStack(offers: ProductOffers): boolean {
  const haystacks = [
    ...offers.promos.map((p) => p.description ?? ''),
    ...offers.bankOffers.map((b) => b.description ?? ''),
  ];
  const re = /(stackab(le|ility)|on already[- ]discounted|stacks? on|in addition to (coupon|promo))/i;
  return haystacks.some((h) => re.test(h));
}

/**
 * Get per-gram IBJA rate for a fineness value.
 */
function getRate(rates: GoldRates, fineness: Fineness): number {
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
 * Calculate savings from PDP promo codes. Returns the best applicable promo.
 */
function calculatePromoSavings(
  price: number,
  promos: ProductOffers['promos'],
): { savings: number; promoCode?: string } {
  let bestSavings = 0;
  let bestCode: string | undefined;

  for (const promo of promos) {
    if (promo.restrictedToNewUser) continue;

    const pctMatch = promo.description.match(/(\d+)%\s*off/i);
    const maxMatch = promo.description.match(/upto\s*Rs\.?\s*([\d,]+)/i);
    const minMatch = promo.description.match(/(?:cart value|minimum|min).*?Rs\.?\s*([\d,]+)/i);

    if (!pctMatch) continue;

    const pct = parseInt(pctMatch[1]);
    const maxCap = maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : Infinity;
    const minOrder = minMatch ? parseInt(minMatch[1].replace(/,/g, '')) : 0;

    if (price < minOrder) continue;

    const discount = Math.min((price * pct) / 100, maxCap);
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
    if (offer.excludesGold) continue;
    if (offer.needsReview) continue;
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
        const cap = offer.parsedCap ?? 1500;
        savings = Math.min((price * pct) / 100, cap);
        break;
      }
      default:
        savings = Math.min(offer.offerAmount, 500);
        break;
    }

    // Sanity: a single offer should never exceed 25% of price.
    savings = Math.min(savings, price * 0.25);

    if (savings > 0) {
      results.push({ offer, savings: Math.round(savings) });
    }
  }

  results.sort((a, b) => b.savings - a.savings);

  // Deduplicate by bankName (keep highest savings per bank).
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
