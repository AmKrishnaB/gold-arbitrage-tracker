import axios, { type AxiosInstance } from 'axios';
import type {
  RawAjioProduct,
  NormalizedProduct,
  AjioPromo,
  AjioBankOffer,
  PlatformOffers,
} from '../config/types.js';
import { parseGoldData, shouldTrackProduct, validateParsedProduct } from '../parsers/goldParser.js';
import { logger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

// ─── Ajio API Config ───

const LISTING_URL_BASE =
  'https://search-edge.services.ajio.com/rilfnlwebservices/v4/rilfnl/products/category';

const LISTING_BASE_PARAMS = {
  advfilter: 'true',
  enableRushDelivery: 'false',
  urgencyDriverEnabled: 'true',
  pageSize: '50',
  store: 'rilfnl',
  fields: 'FULL',
  tmpid: '2',
  rsflag: '1',
  platform: 'android',
  offer_price_ab_enabled: 'false',
  displayRatings: 'true',
  vertexEnabled: 'false',
  userEncryptedId: '0d192eb4-0be9-4e3d-ba02-e64b10723c57',
  tagV2Enabled: 'false',
  plaAdsProvider: 'OSMOS',
  plaAdsEliminationDisabled: 'false',
  is_ads_enable_plp: 'true',
  showAdsOnNextPage: 'false',
};

// Multiple queries across categories to catch all gold items:
// 1. Curated "Gold Coins & Bars" (category 83) — primary, catches most 22K/24K coins and bars
// 2. 24K filter on all jewellery (category 83) — catches items in sub-categories
// 3. Women Rings category (830306004) with 24K filter — catches vedhanis (24K gold bands)
const LISTING_QUERIES: Array<{ url: string; params: Record<string, string>; label: string }> = [
  {
    label: 'Curated Coins & Bars',
    url: `${LISTING_URL_BASE}/83`,
    params: {
      ...LISTING_BASE_PARAMS,
      curatedid: 'ham-gold-coins-and-bars-4775-71731',
      curated: 'true',
      query: '',
    },
  },
  {
    label: '24K All Categories',
    url: `${LISTING_URL_BASE}/83`,
    params: {
      ...LISTING_BASE_PARAMS,
      query: ':relevance:verticalmetalpurity:24 Kt:verticalmetalpurity:24 Kt (995)',
    },
  },
  {
    label: '24K Rings (Vedhanis)',
    url: `${LISTING_URL_BASE}/830306004`,
    params: {
      ...LISTING_BASE_PARAMS,
      query: ':relevance:verticalmetalpurity:24 Kt:verticalmetalpurity:24 Kt (995)',
    },
  },
];

const PDP_BASE_URL = 'https://pdpaggregator-edge.services.ajio.com/aggregator/pdp';

const AJIO_HEADERS = {
  'Requestid': 'PLPCategoryProducts',
  'Os': '1',
  'Ai': 'com.ril.ajio',
  'Vr': 'AN-2.1.21',
  'Accept': 'application/json',
  'User-Agent': 'Ajio/9.31.1 (Android 15)',
  'Client_type': 'Android',
  'Client_version': '9.31.1',
  'Ad_id': 'a83b86e6-a24e-49f8-8797-aa93165a1365',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

const PDP_HEADERS = {
  'Requestid': 'ProductDetails',
  'Accept': 'application/json',
  'User-Agent': 'Ajio/9.31.1 (Android 15)',
  'Client_type': 'Android',
  'Client_version': '9.31.1',
  'Ad_id': 'a83b86e6-a24e-49f8-8797-aa93165a1365',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

// ─── Sentinel Products for PDP promo extraction ───

const SENTINEL_PRODUCTS = [
  '6006341870_multi',  // C Krishniah 1gm 24Kt Coin
  '6005351710_multi',  // MMTC-PAMP 1gm 24K Coin
  '6005351730_multi',  // MMTC-PAMP 5gm 24K Bar
  '6005351740_multi',  // MMTC-PAMP 10gm 24K Bar
  '6005351720_multi',  // MMTC-PAMP 2gm 24K Coin
];

// ─── Client ───

function createClient(): AxiosInstance {
  return axios.create({
    timeout: 15_000,
    headers: AJIO_HEADERS,
  });
}

// ─── Listing API ───

interface AjioListingResponse {
  products: RawAjioProduct[];
  pagination?: {
    totalResults: number;
    totalPages: number;
    currentPage: number;
    pageSize: number;
  };
  searchMetaData?: {
    numberOfProducts: number;
  };
}

/**
 * Fetch a single page of Ajio gold listings.
 */
async function fetchListingPage(page: number, url: string, params: Record<string, string>): Promise<AjioListingResponse> {
  const client = createClient();
  const res = await client.get<AjioListingResponse>(url, {
    params: { ...params, currentPage: page.toString() },
  });
  return res.data;
}

/**
 * Fetch ALL Ajio gold listings across multiple queries.
 * Uses curated coins & bars + 24K query for expanded coverage.
 * Deduplicates by product code.
 */
export async function fetchAllAjioProducts(): Promise<NormalizedProduct[]> {
  const startTime = Date.now();
  const allRaw: RawAjioProduct[] = [];
  const seenCodes = new Set<string>();

  for (const { url, params, label } of LISTING_QUERIES) {
    // First page to get total count for this query
    const firstPage = await retry(
      () => fetchListingPage(0, url, params),
      { retries: 3, delayMs: 1000, label: `Ajio ${label} page 0` },
    );

    const totalResults = firstPage.pagination?.totalResults
      ?? firstPage.searchMetaData?.numberOfProducts
      ?? firstPage.products.length;
    const pageSize = firstPage.pagination?.pageSize ?? 50;
    const totalPages = Math.ceil(totalResults / pageSize);

    logger.info({ query: label, totalResults, totalPages }, 'Ajio: starting query fetch');

    // Dedup and collect first page
    for (const p of firstPage.products) {
      if (!seenCodes.has(p.code)) {
        seenCodes.add(p.code);
        allRaw.push(p);
      }
    }

    // Fetch remaining pages in parallel
    const pagePromises: Promise<AjioListingResponse>[] = [];
    for (let p = 1; p < totalPages; p++) {
      pagePromises.push(
        retry(() => fetchListingPage(p, url, params), {
          retries: 2,
          delayMs: 500,
          label: `Ajio ${label} page ${p}`,
        }),
      );
    }

    const remainingPages = await Promise.allSettled(pagePromises);
    for (const result of remainingPages) {
      if (result.status === 'fulfilled') {
        for (const p of result.value.products) {
          if (!seenCodes.has(p.code)) {
            seenCodes.add(p.code);
            allRaw.push(p);
          }
        }
      } else {
        logger.warn({ error: result.reason?.message }, 'Ajio: page fetch failed');
      }
    }
  }

  // Normalize products
  const normalized: NormalizedProduct[] = [];
  let failed = 0;

  for (const raw of allRaw) {
    try {
      const product = normalizeAjioProduct(raw);
      if (product) normalized.push(product);
    } catch (err) {
      failed++;
      logger.debug({ code: raw.code, error: (err as Error).message }, 'Ajio: product parse failed');
    }
  }

  const duration = Date.now() - startTime;
  logger.info(
    { total: allRaw.length, normalized: normalized.length, failed, durationMs: duration },
    'Ajio: fetch complete',
  );

  return normalized;
}

/**
 * Normalize a raw Ajio product into our standard format.
 * Returns null if product should be skipped.
 */
function normalizeAjioProduct(raw: RawAjioProduct): NormalizedProduct | null {
  // Filter: only gold coins and bars
  if (!shouldTrackProduct(raw.name)) return null;

  // Parse gold data from name
  const parsed = parseGoldData(raw.name);
  if (parsed.totalWeightGrams <= 0) return null;

  // Price extraction
  const mrp = raw.wasPriceData?.value ?? raw.price.value;
  const sellingPrice = raw.price.value;
  const offerPrice = raw.offerPrice?.value;
  const effectivePrice = offerPrice ?? sellingPrice;

  // Discount
  const discountMatch = raw.discountPercent?.match(/(\d+)/);
  const discountPercent = discountMatch ? parseInt(discountMatch[1]) : 0;

  // Validate
  const extraWarnings = validateParsedProduct(parsed, effectivePrice, raw.name);

  // Skip suspicious products (mislabeled weights)
  if (extraWarnings.some((w) => w.includes('SUSPICIOUS_PRICE_PER_GRAM'))) {
    logger.debug({ code: raw.code, name: raw.name, warnings: extraWarnings }, 'Ajio: skipping suspicious product');
    return null;
  }

  return {
    id: `ajio:${raw.code}`,
    platform: 'ajio',
    name: raw.name,
    brand: raw.fnlColorVariantData?.brandName ?? 'Unknown',
    url: `https://www.ajio.com${raw.url}`,

    totalWeightGrams: parsed.totalWeightGrams,
    fineness: parsed.fineness,
    karat: parsed.karat,
    isCombo: parsed.isCombo,
    pieceCount: parsed.pieceCount,

    mrp,
    sellingPrice,
    offerPrice,
    effectivePrice,
    discountPercent,

    weightSource: parsed.weightSource,
    puritySource: parsed.puritySource,
    parseWarnings: [...parsed.parseWarnings, ...extraWarnings],

    rating: raw.averageRating,
    ratingCount: raw.ratingCount ? parseInt(raw.ratingCount) : undefined,
    imageUrl: raw.fnlColorVariantData?.outfitPictureURL,
  };
}

// ─── PDP API (for promos & bank offers) ───

interface AjioPDPResponse {
  potentialPromotions?: Array<{
    code: string;
    description: string;
    maxSavingPrice: number;
    endTime: string;
    restrictedToNewUser: boolean;
  }>;
  prepaidOffers?: Array<{
    bankName: string;
    description: string;
    offerAmount: number;
    thresholdAmount: number;
    absolute: boolean;
    type: string;
    eligiblePaymentInstruments: string[];
    endDate: number;
    tncUrl?: string;
    offerCode?: string;
  }>;
  stock?: {
    stockLevelStatus: string;
  };
}

// ─── T&C Cache — no longer used for gold exclusion ───
// Offers are per-product: if Ajio's API serves them on a gold PDP, they're applicable.
// We only parse descriptions for type/cap extraction.

/**
 * Fetch platform-wide offers from a sentinel PDP product.
 * Enriches bank offers with parsed type/cap from description.
 * No gold exclusion logic — if the API serves it on gold products, it's valid.
 */
export async function fetchAjioOffers(): Promise<PlatformOffers> {
  const client = axios.create({ timeout: 15_000, headers: PDP_HEADERS });

  for (const code of SENTINEL_PRODUCTS) {
    try {
      const url = `${PDP_BASE_URL}/${code}?sortOptionsByColor=true&client_type=Android&client_version=9.31.1&isNewUser=true&tagVersionTwo=false&applyExperiment=false&fields=FULL`;
      const res = await client.get<AjioPDPResponse>(url);
      const data = res.data;

      const promos: AjioPromo[] = (data.potentialPromotions ?? []).map((p) => ({
        code: p.code,
        description: p.description,
        maxSavingPrice: p.maxSavingPrice,
        endTime: p.endTime,
        restrictedToNewUser: p.restrictedToNewUser,
      }));

      // Enrich bank offers with parsed data + T&C check
      const rawOffers = data.prepaidOffers ?? [];
      const bankOffers: AjioBankOffer[] = [];

      for (const o of rawOffers) {
        const enriched = await enrichBankOffer(o);
        bankOffers.push(enriched);
      }

      const goldApplicable = bankOffers.filter((o) => !o.excludesGold && !o.needsReview).length;
      const goldExcluded = bankOffers.filter((o) => o.excludesGold).length;
      const needsReview = bankOffers.filter((o) => o.needsReview).length;

      logger.info(
        { sentinel: code, promos: promos.length, bankOffers: bankOffers.length, goldApplicable, goldExcluded, needsReview },
        'Ajio: offers fetched and enriched from sentinel PDP',
      );

      return { platform: 'ajio', promos, bankOffers, fetchedAt: Date.now() };
    } catch (err) {
      logger.warn(
        { sentinel: code, error: (err as Error).message },
        'Ajio: sentinel PDP failed, trying next',
      );
    }
  }

  logger.error('Ajio: all sentinel PDPs failed');
  return { platform: 'ajio', promos: [], bankOffers: [], fetchedAt: Date.now() };
}

// ─── Offer Enrichment ───

/**
 * Parse a bank offer's description to determine type, percentage, and cap.
 * No gold exclusion logic — if Ajio serves the offer on gold PDPs, it's applicable.
 */
async function enrichBankOffer(raw: {
  bankName: string;
  description: string;
  offerAmount: number;
  thresholdAmount: number;
  absolute: boolean;
  type: string;
  eligiblePaymentInstruments: string[];
  endDate: number;
  tncUrl?: string;
  offerCode?: string;
}): Promise<AjioBankOffer> {
  const parsed = parseOfferDescription(raw.description, raw.offerAmount, raw.absolute);

  return {
    bankName: raw.bankName,
    description: raw.description,
    offerAmount: raw.offerAmount,
    thresholdAmount: raw.thresholdAmount,
    absolute: raw.absolute,
    type: raw.type,
    eligiblePaymentInstruments: raw.eligiblePaymentInstruments,
    endDate: raw.endDate,
    tncUrl: raw.tncUrl,
    offerCode: raw.offerCode,
    parsedType: parsed.parsedType,
    parsedPct: parsed.parsedPct,
    parsedCap: parsed.parsedCap,
    excludesGold: false,
    needsReview: false,
  };
}

/**
 * Parse offer description to determine type, percentage, and cap.
 *
 * Patterns:
 *   "Flat Rs. 150 Assured Cashback"          → flat, cap=150
 *   "Flat INR 100 cashback"                   → flat, cap=100
 *   "Flat Rs15 cashback"                      → flat, cap=15
 *   "Upto Rs. 500 Cashback"                   → cashback_cap, cap=500
 *   "Assured cashback up to ₹500"             → cashback_cap, cap=500
 *   "5% instant discount upto Rs.1500"        → percent, pct=5, cap=1500
 *   "10% Instant Discount up to Rs. 1500"     → percent, pct=10, cap=1500
 *   "12% Instant Discount"                    → percent, pct=12, cap=null
 */
function parseOfferDescription(
  desc: string,
  offerAmount: number,
  absolute: boolean,
): { parsedType: 'flat' | 'percent' | 'cashback_cap' | 'unknown'; parsedPct: number | null; parsedCap: number | null } {
  // Regex for money amounts: Rs., Rs, ₹, INR followed by optional space and digits
  const moneyRe = /(?:Rs\.?|₹|INR)\s*([\d,]+)/gi;

  // Check for flat amount: "Flat Rs. 150" or "Flat ₹150" or "Flat INR 100"
  const flatMatch = desc.match(/\bFlat\s+(?:Rs\.?|₹|INR)\s*([\d,]+)/i);
  if (flatMatch) {
    const cap = parseInt(flatMatch[1].replace(/,/g, ''));
    return { parsedType: 'flat', parsedPct: null, parsedCap: cap };
  }

  // Check for percentage: "5% instant discount" or "10% Instant Discount"
  const pctMatch = desc.match(/(\d+)\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1]);
    // Look for cap: "upto Rs. 1500" or "up to ₹1,500" or "of up to Rs. 1000"
    const capMatch = desc.match(/(?:up\s*to|upto)\s*(?:Rs\.?|₹|INR)\s*([\d,]+)/i);
    const cap = capMatch ? parseInt(capMatch[1].replace(/,/g, '')) : null;
    return { parsedType: 'percent', parsedPct: pct, parsedCap: cap };
  }

  // Check for cashback cap: "Upto Rs. 500 Cashback" or "up to ₹500"
  const cashbackCapMatch = desc.match(/(?:up\s*to|upto)\s*(?:Rs\.?|₹|INR)\s*([\d,]+)/i);
  if (cashbackCapMatch) {
    const cap = parseInt(cashbackCapMatch[1].replace(/,/g, ''));
    return { parsedType: 'cashback_cap', parsedPct: null, parsedCap: cap };
  }

  // If absolute flag is true, it's a flat amount
  if (absolute) {
    return { parsedType: 'flat', parsedPct: null, parsedCap: offerAmount };
  }

  // Fallback: if offerAmount is large (>= 50), likely a cashback cap
  // If small (< 50) but no % in description, still treat as flat cashback to be safe
  if (offerAmount >= 50) {
    return { parsedType: 'cashback_cap', parsedPct: null, parsedCap: offerAmount };
  }

  // Small offerAmount, no % in desc — treat as flat (e.g., "Rs 15 cashback" without "Flat" prefix)
  return { parsedType: 'flat', parsedPct: null, parsedCap: offerAmount };
}


