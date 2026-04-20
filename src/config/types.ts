// ─── Platform Types ───

export type Platform = 'myntra' | 'ajio';

export type DealStatus = 'active' | 'expired' | 'oos';

export type NotificationAction = 'SEND_NEW' | 'EDIT' | 'NOTHING' | 'EXPIRE';

// ─── IBJA Rate Types ───

export interface IBJARates {
  date: string;
  lblGold999_AM: string;
  lblGold995_AM: string;
  lblGold916_AM: string;
  lblGold750_AM: string;
  lblGold585_AM: string;
  lblGold585_PM: string;
  lblGold750_PM: string;
  lblGold916_PM: string;
  lblGold995_PM: string;
  lblGold999_PM: string;
}

export interface GoldRates {
  date: string;
  fetchedAt: number;
  perGram: {
    999: number;
    995: number;
    916: number;
    750: number;
    585: number;
  };
  session: 'AM' | 'PM';
}

// ─── Parser Types ───

export type WeightSource =
  | 'explicit_total'
  | 'bracket_multiplication'
  | 'n_pieces'
  | 'pack_set'
  | 'addition'
  | 'single'
  | 'unknown';

export type PuritySource =
  | 'fineness_bracket'
  | 'fineness_standalone'
  | 'karat_default'
  | 'unknown';

export type Fineness = 999.9 | 999 | 995 | 916 | 750 | 585;

export interface ParsedGoldData {
  totalWeightGrams: number;
  fineness: Fineness;
  karat: number;
  isCombo: boolean;
  pieceCount: number;
  weightSource: WeightSource;
  puritySource: PuritySource;
  parseWarnings: string[];
}

// ─── Product Types ───

export interface RawAjioProduct {
  code: string;
  name: string;
  fnlColorVariantData: {
    brandName: string;
    outfitPictureURL?: string;
    colorGroup?: string;
  };
  price: { value: number; displayformattedValue: string };
  wasPriceData: { value: number; displayformattedValue: string };
  offerPrice?: { value: number; displayformattedValue: string };
  discountPercent: string;
  url: string;
  averageRating?: number;
  ratingCount?: string;
  brickNameText?: string;
  segmentNameText?: string;
}

export interface RawMyntraProduct {
  styleId: number;
  productInfo: {
    brand: string;
    additionalInfo: string;
    priceInfo: {
      mrp: string;
      price: string;
      discountDisplayLabel: string;
    };
  };
  productImage?: {
    ratingInfo?: {
      rating: string;
      count: string;
    };
  };
  onLongPress?: {
    modalData: {
      productName: string;
      mrp: number;
      price: number;
    };
  };
  couponData?: false | { text: string };
  onPress?: { route: string };
}

export interface NormalizedProduct {
  id: string;
  platform: Platform;
  name: string;
  brand: string;
  url: string;

  // Parsed gold data
  totalWeightGrams: number;
  fineness: Fineness;
  karat: number;
  isCombo: boolean;
  pieceCount: number;

  // Pricing
  mrp: number;
  sellingPrice: number;
  offerPrice?: number;      // Ajio 3rd tier (post-promo price)
  couponPrice?: number;     // Myntra coupon-applied price
  discountPercent: number;

  // Effective = lowest available price (post-listing-promo, pre-bank-offer).
  // Kept for back-compat with shortlist filtering and downstream reads.
  effectivePrice: number;

  // ─── Three-field pricing breakdown (Ajio) ───
  // Distinct values per product so downstream code can show/stack them correctly.
  // Myntra populates listedPrice + promoDiscount where possible; bankDiscount is Ajio-only
  // (Myntra PDP bank offers are not currently scraped — see myntra.ts TODO).
  //
  // listedPrice   — pre-cart-promo listed price the user sees as the main price
  //                 (Ajio: raw.price.value; NOT MRP which is the struck-through wasPrice).
  // promoDiscount — listedPrice - offerPrice. Cart-level promo savings from listing.
  // bankDiscount  — populated later by dealDetector from PDP-scraped bank offers.
  //                 MUST NOT come from a static/hardcoded table (user-mandated).
  listedPrice?: number;
  promoDiscount?: number;
  bankDiscount?: number;

  // Parse metadata
  weightSource: WeightSource;
  puritySource: PuritySource;
  parseWarnings: string[];

  // Optional
  rating?: number;
  ratingCount?: number;
  imageUrl?: string;
}

// ─── Promo / Offer Types ───

export interface AjioPromo {
  code: string;
  description: string;
  maxSavingPrice: number;
  endTime: string;
  restrictedToNewUser: boolean;
}

export interface AjioBankOffer {
  bankName: string;
  description: string;
  offerAmount: number;        // percentage or flat
  thresholdAmount: number;    // min order value
  absolute: boolean;          // true = flat ₹, false = percentage
  type: string;
  eligiblePaymentInstruments: string[];
  endDate: number;
  tncUrl?: string;
  offerCode?: string;

  // Enriched at fetch time (description parsing + T&C check)
  parsedType: 'flat' | 'percent' | 'cashback_cap' | 'unknown';
  parsedPct: number | null;        // e.g. 5, 10, 12 (null for flat/cashback)
  parsedCap: number | null;        // max discount in ₹ (from desc or T&C)
  excludesGold: boolean;           // from T&C page
  needsReview: boolean;            // couldn't determine gold exclusion
}

export interface PlatformOffers {
  platform: Platform;
  promos: AjioPromo[];
  bankOffers: AjioBankOffer[];
  fetchedAt: number;
}

/**
 * Per-product offers fetched from PDP.
 * These are the REAL offers for a specific product.
 */
export interface ProductOffers {
  productId: string;
  promos: AjioPromo[];
  bankOffers: AjioBankOffer[];
  fetchedAt: number;
}

// ─── Deal Types ───

export interface Deal {
  product: NormalizedProduct;
  marketValue: number;
  effectivePrice: number;
  savings: number;
  savingsPct: number;

  // Ajio-specific additional savings
  promoSavings: number;
  appliedPromoCode?: string;          // e.g., "DHANVARSHA2"
  bestBankOffer?: AjioBankOffer;
  bankOfferSavings: number;
  topBankOffers: BankOfferResult[];   // Top 3 applicable offers with calculated savings

  // ─── Three-field breakdown (primarily Ajio) ───
  // listedPrice = pre-cart-promo listed price (what the user sees on the listing card).
  // promoDiscount = savings from cart-level promo (max of listing-derived and PDP-derived).
  // bankDiscount = savings from the best applicable bank offer (from PDP; 0 if none).
  listedPrice: number;
  promoDiscount: number;
  bankDiscount: number;

  // Final price after applying the BETTER of promoDiscount / bankDiscount (non-stacking by default).
  finalPrice: number;
  totalSavings: number;
  totalSavingsPct: number;

  ibjaRate: number;            // Per-gram IBJA rate used
  ibjaSession: 'AM' | 'PM';
  detectedAt: number;
  affiliateUrl?: string;       // EarnKaro affiliate link (generated after detection)
}

export interface BankOfferResult {
  offer: AjioBankOffer;
  savings: number;
}

// ─── Notification Types ───

export interface SentMessage {
  id?: number;
  dealProductId: string;
  platform: Platform;
  subscriberChatId: string;
  telegramMessageId: number;
  lastStatus: DealStatus | 'price_drop' | 'better_offer';
  lastNotifiedPrice: number;
  lastNotifiedSavingsPct: number;
  lastPromoHash: string;
  lastEditedAt: number;
  createdAt: number;
}

// ─── Subscriber Types ───

export interface Subscriber {
  id?: number;
  chatId: string;
  username?: string;
  firstName?: string;
  isAdmin: boolean;
  isActive: boolean;
  mode: 'instant' | 'digest' | 'both';
  minSavingsRupees: number;
  joinedAt: number;
}
