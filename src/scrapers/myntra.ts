import axios, { type AxiosInstance } from 'axios';
import type { RawMyntraProduct, NormalizedProduct } from '../config/types.js';
import { parseGoldData, shouldTrackProduct, validateParsedProduct } from '../parsers/goldParser.js';
import { logger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

// ─── Myntra API Config ───

const LISTING_URL = 'https://api.myntra.com/v3/layout/search/women-jewellery';

const LISTING_PARAMS = {
  f: 'Categories:Gold Coin',
  nf: 'Brand:Divine Solitaires,Nipura,PMJ Jewels,White Mango Decor',
  selectAllChecked: '{"f":"Brand"}',
  sort: 'discount',
};

const MYNTRA_HEADERS = {
  'Accept': 'application/json; charset=utf-8',
  'Accept-Language': 'en-US,en;q=0.5',
  'At': 'ZXlKaGJHY2lPaUpJVXpJMU5pSXNJbXRwWkNJNklqRWlMQ0owZVhBaU9pSktWMVFpZlEuZXlKdWFXUjRJam9pTjJKak0ySXdZV0l0TXpFeFpTMHhNV1l4TFRrM1pERXRNR0UzWkRNNU1qSTROVFF3SWl3aVkybGtlQ0k2SW0xNWJuUnlZUzB3TW1RM1pHVmpOUzA0WVRBd0xUUmpOelF0T1dObU55MDVaRFl5WkdKbFlUVmxOakVpTENKaGNIQk9ZVzFsSWpvaWJYbHVkSEpoSWl3aWMzUnZjbVZKWkNJNklqSXlPVGNpTENKbGVIQWlPakUzT1RBNU5qWXlORElzSW1semN5STZJa2xFUlVFaWZRLlFaX3FILWk3Tkw3Z2xuRHp2RHBMNTZxRk5nc0hjYkQ1akdSZG9aWHB5OVU=',
  'User-Agent': 'MyntraRetailAndroid/4.2603.10 (Phone, 420dpi); MyntraAndroid/4.2603.10 (Phone, 420dpi); api;',
  'X-Myntra-Store-Context': 'myntra',
  'X-Location-Context': 'source=IP;pincode=411001;pincodeSource=MAXMIND;lat=;long=;hexagonId=;addressId=;city=;stateCode=',
  'User-State': 'CUSTOMER',
  'Content-Type': 'application/json; charset=utf-8',
};

// ─── Client ───

function createClient(): AxiosInstance {
  return axios.create({
    timeout: 15_000,
    headers: MYNTRA_HEADERS,
  });
}

// ─── Response Types ───

interface MyntraListingResponse {
  layout: {
    components: Array<{
      itemData: {
        widgetType: string;
        data: RawMyntraProduct;
      };
    }>;
  };
  pagination?: {
    nextPage?: {
      type: string;
      params: {
        uri: string;
        paginationContext: Record<string, unknown>;
      };
    };
  };
}

// ─── Listing Fetcher ───

function buildRequestBody(paginationContext?: Record<string, unknown>): object {
  const base = {
    pageContext: {
      RequestPayloadData: {
        sessionContext: { plpContext: {}, version: '1', pdpContext: [] },
        pincode: '411001',
        userAttributes: { upsCohortId: [], gsCohortId: [], speedSegments: [], segmentInfo: [] },
        requestType: 'CHANGE_URI',
        pageTitle: 'women jewellery',
        storeContext: 'Myntra',
        searchMode: 'query',
        userQuery: false,
        showFloatingTimer: true,
        scPostId: '',
        fwdNav: 0.0,
        userBucket: 'CUSTOMER',
      },
    },
    pageUri: `/v3/layout/search/women-jewellery?f=Categories%3AGold%20Coin&nf=Brand%3ADivine%20Solitaires%2CNipura%2CPMJ%20Jewels%2CWhite%20Mango%20Decor&selectAllChecked=%7B%22f%22%3A%22Brand%22%7D&sort=discount`,
  };

  if (paginationContext) {
    return { ...base, paginationContext };
  }
  return base;
}

/**
 * Fetch a single page of Myntra listings.
 * First page: no pagination context.
 * Subsequent pages: must provide paginationContext from previous response.
 */
async function fetchListingPage(
  paginationContext?: Record<string, unknown>,
): Promise<MyntraListingResponse> {
  const client = createClient();

  const url = paginationContext
    ? `https://api.myntra.com${(paginationContext as any)?.uri || LISTING_URL}`
    : `${LISTING_URL}?${new URLSearchParams(LISTING_PARAMS as Record<string, string>)}`;

  const body = buildRequestBody(
    paginationContext ? (paginationContext as any)?.paginationContext : undefined,
  );

  const res = await client.post<MyntraListingResponse>(url, body);
  return res.data;
}

/**
 * Extract product tiles from a Myntra listing response.
 */
function extractProductTiles(response: MyntraListingResponse): RawMyntraProduct[] {
  return (response.layout?.components ?? [])
    .filter((c) => c.itemData?.widgetType === 'PRODUCT_TILE')
    .map((c) => c.itemData.data);
}

/**
 * Fetch ALL Myntra gold coin listings using cursor-based pagination.
 * Must be sequential — each page depends on previous response's cursor.
 */
export async function fetchAllMyntraProducts(): Promise<NormalizedProduct[]> {
  const startTime = Date.now();
  const allRaw: RawMyntraProduct[] = [];
  let nextPageParams: Record<string, unknown> | undefined;
  let pageNum = 0;

  do {
    try {
      const response = await retry(
        () => fetchListingPage(nextPageParams),
        { retries: 2, delayMs: 1000, label: `Myntra page ${pageNum}` },
      );

      const tiles = extractProductTiles(response);
      allRaw.push(...tiles);

      logger.debug({ page: pageNum, products: tiles.length }, 'Myntra: page fetched');

      // Get next page cursor
      nextPageParams = response.pagination?.nextPage?.params as Record<string, unknown> | undefined;
      pageNum++;

      // Safety limit
      if (pageNum > 20) {
        logger.warn('Myntra: hit page safety limit');
        break;
      }

      // Small delay between pages to be polite
      if (nextPageParams) {
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      logger.error({ page: pageNum, error: (err as Error).message }, 'Myntra: page fetch failed');
      break;
    }
  } while (nextPageParams);

  // Normalize
  const normalized: NormalizedProduct[] = [];
  let failed = 0;

  for (const raw of allRaw) {
    try {
      const product = normalizeMyntraProduct(raw);
      if (product) normalized.push(product);
    } catch (err) {
      failed++;
      logger.debug({ styleId: raw.styleId, error: (err as Error).message }, 'Myntra: product parse failed');
    }
  }

  const duration = Date.now() - startTime;
  logger.info(
    { total: allRaw.length, normalized: normalized.length, failed, pages: pageNum, durationMs: duration },
    'Myntra: fetch complete',
  );

  return normalized;
}

/**
 * Normalize a raw Myntra product into standard format.
 * Returns null if product should be skipped.
 */
function normalizeMyntraProduct(raw: RawMyntraProduct): NormalizedProduct | null {
  const productName =
    raw.onLongPress?.modalData?.productName ??
    `${raw.productInfo?.brand ?? ''} ${raw.productInfo?.additionalInfo ?? ''}`.trim();

  if (!productName) return null;

  // Filter: only gold coins and bars
  if (!shouldTrackProduct(productName)) return null;

  // Parse gold data
  const parsed = parseGoldData(productName);
  if (parsed.totalWeightGrams <= 0) return null;

  // Price extraction
  const mrp = raw.onLongPress?.modalData?.mrp ?? parsePriceString(raw.productInfo?.priceInfo?.mrp);
  const sellingPrice = raw.onLongPress?.modalData?.price ?? parsePriceString(raw.productInfo?.priceInfo?.price);

  if (!mrp || !sellingPrice) return null;

  // Coupon price (parse from couponData.text if available)
  let couponPrice: number | undefined;
  if (raw.couponData && raw.couponData !== false) {
    couponPrice = parseCouponPrice(raw.couponData.text);
  }

  const effectivePrice = couponPrice ?? sellingPrice;

  // Discount
  const discountMatch = raw.productInfo?.priceInfo?.discountDisplayLabel?.match(/(\d+)/);
  const discountPercent = discountMatch ? parseInt(discountMatch[1]) : 0;

  // Validate
  const extraWarnings = validateParsedProduct(parsed, effectivePrice, productName);

  // Skip suspicious
  if (extraWarnings.some((w) => w.includes('SUSPICIOUS_PRICE_PER_GRAM'))) {
    logger.debug({ styleId: raw.styleId, name: productName, warnings: extraWarnings }, 'Myntra: skipping suspicious product');
    return null;
  }

  // Build product URL
  const styleId = raw.styleId?.toString() ?? '';
  const url = `https://www.myntra.com/${styleId}`;

  return {
    id: `myntra:${styleId}`,
    platform: 'myntra',
    name: productName,
    brand: raw.productInfo?.brand ?? 'Unknown',
    url,

    totalWeightGrams: parsed.totalWeightGrams,
    fineness: parsed.fineness,
    karat: parsed.karat,
    isCombo: parsed.isCombo,
    pieceCount: parsed.pieceCount,

    mrp,
    sellingPrice,
    couponPrice,
    effectivePrice,
    discountPercent,

    weightSource: parsed.weightSource,
    puritySource: parsed.puritySource,
    parseWarnings: [...parsed.parseWarnings, ...extraWarnings],

    rating: raw.productImage?.ratingInfo?.rating ? parseFloat(raw.productImage.ratingInfo.rating) : undefined,
    ratingCount: raw.productImage?.ratingInfo?.count ? parseInt(raw.productImage.ratingInfo.count) : undefined,
  };
}

// ─── Helpers ───

function parsePriceString(price?: string): number {
  if (!price) return 0;
  return parseInt(price.replace(/[^0-9]/g, '')) || 0;
}

function parseCouponPrice(text: string): number | undefined {
  // Parse from: "<Text>Best Price</Text> <Text>₹65,459</Text> with coupon"
  const match = text.match(/[\u20B9₹]?\s*([\d,]+)/);
  if (!match) return undefined;
  return parseInt(match[1].replace(/,/g, ''));
}
