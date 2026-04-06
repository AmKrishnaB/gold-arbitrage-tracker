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

const LISTING_BASE_URL =
  'https://search-edge.services.ajio.com/rilfnlwebservices/v4/rilfnl/products/category/83';

const LISTING_PARAMS = {
  advfilter: 'true',
  curatedid: 'ham-gold-coins-and-bars-4775-71731',
  curated: 'true',
  enableRushDelivery: 'false',
  urgencyDriverEnabled: 'true',
  query: '',
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
 * Fetch a single page of Ajio gold coin/bar listings.
 */
async function fetchListingPage(page: number): Promise<AjioListingResponse> {
  const client = createClient();
  const res = await client.get<AjioListingResponse>(LISTING_BASE_URL, {
    params: { ...LISTING_PARAMS, currentPage: page.toString() },
  });
  return res.data;
}

/**
 * Fetch ALL Ajio gold coin/bar listings across all pages.
 * Pages are fetched in parallel for speed.
 */
export async function fetchAllAjioProducts(): Promise<NormalizedProduct[]> {
  const startTime = Date.now();

  // First page to get total count
  const firstPage = await retry(
    () => fetchListingPage(0),
    { retries: 3, delayMs: 1000, label: 'Ajio page 0' },
  );

  const totalResults = firstPage.pagination?.totalResults
    ?? firstPage.searchMetaData?.numberOfProducts
    ?? firstPage.products.length;
  const pageSize = firstPage.pagination?.pageSize ?? 50;
  const totalPages = Math.ceil(totalResults / pageSize);

  logger.info({ totalResults, totalPages }, 'Ajio: starting fetch');

  // Fetch remaining pages in parallel
  const pagePromises: Promise<AjioListingResponse>[] = [];
  for (let p = 1; p < totalPages; p++) {
    pagePromises.push(
      retry(() => fetchListingPage(p), {
        retries: 2,
        delayMs: 500,
        label: `Ajio page ${p}`,
      }),
    );
  }

  const remainingPages = await Promise.allSettled(pagePromises);

  // Collect all raw products
  const allRaw: RawAjioProduct[] = [...firstPage.products];
  for (const result of remainingPages) {
    if (result.status === 'fulfilled') {
      allRaw.push(...result.value.products);
    } else {
      logger.warn({ error: result.reason?.message }, 'Ajio: page fetch failed');
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
  }>;
  stock?: {
    stockLevelStatus: string;
  };
}

/**
 * Fetch platform-wide offers from a sentinel PDP product.
 * Tries each sentinel in order until one succeeds.
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

      const bankOffers: AjioBankOffer[] = (data.prepaidOffers ?? []).map((o) => ({
        bankName: o.bankName,
        description: o.description,
        offerAmount: o.offerAmount,
        thresholdAmount: o.thresholdAmount,
        absolute: o.absolute,
        type: o.type,
        eligiblePaymentInstruments: o.eligiblePaymentInstruments,
        endDate: o.endDate,
        tncUrl: o.tncUrl,
      }));

      logger.info(
        { sentinel: code, promos: promos.length, bankOffers: bankOffers.length },
        'Ajio: offers fetched from sentinel PDP',
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
