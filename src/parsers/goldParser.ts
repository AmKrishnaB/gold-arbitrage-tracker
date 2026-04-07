import type { ParsedGoldData, Fineness, WeightSource, PuritySource } from '../config/types.js';

// ─── Known Fineness Values ───
const VALID_FINENESS = new Set<number>([999.9, 999, 995, 916, 750, 585]);

const KARAT_TO_FINENESS: Record<number, Fineness> = {
  24: 999,
  22: 916,
  18: 750,
  14: 585,
};

/**
 * Parse gold weight and purity from a product name string.
 * Handles combos, multi-piece packs, additions, and single products.
 */
export function parseGoldData(name: string): ParsedGoldData {
  const warnings: string[] = [];

  const weight = parseWeight(name, warnings);
  const purity = parsePurity(name, warnings);

  const isCombo = weight.pieceCount > 1;

  return {
    totalWeightGrams: weight.grams,
    fineness: purity.fineness,
    karat: purity.karat,
    isCombo,
    pieceCount: weight.pieceCount,
    weightSource: weight.source,
    puritySource: purity.source,
    parseWarnings: warnings,
  };
}

// ─────────────────────────────────────────────────
// WEIGHT PARSING
// ─────────────────────────────────────────────────

interface WeightResult {
  grams: number;
  pieceCount: number;
  source: WeightSource;
}

function parseWeight(name: string, warnings: string[]): WeightResult {
  // Normalize the string for easier matching
  const n = name.replace(/\s+/g, ' ').trim();

  // 1. EXPLICIT TOTAL BEFORE BRACKETS: "4.5 Gm (0.5 Gm + 2 Gm + 2 Gm)"
  const explicitTotal = tryExplicitTotal(n);
  if (explicitTotal) return explicitTotal;

  // 2. BRACKET MULTIPLICATION: "(1gm each x 5 Pcs)" or "(2gm each x 2 Pcs)"
  const bracketMul = tryBracketMultiplication(n);
  if (bracketMul) return bracketMul;

  // 3. N-PIECES: "6Pcs 24KT Gold Coin - 2 g Each" or "2Pcs...1 g Each"
  const nPieces = tryNPieces(n);
  if (nPieces) return nPieces;

  // 4. PACK/SET: "Pack Of 3...5gm each" or "Set of 2...Gold Bar"
  const packSet = tryPackSet(n);
  if (packSet) return packSet;

  // 5. ADDITION: "2 GM + 2 GM" or "0.5 Gm + 2 Gm + 2 Gm"
  const addition = tryAddition(n);
  if (addition) return addition;

  // 6. SIMPLE SINGLE WEIGHT: "1 Gm", "2g", "20Gm", "0.5 gram"
  const single = trySingleWeight(n);
  if (single) return single;

  // 7. FAILED
  warnings.push('WEIGHT_UNPARSEABLE: Could not extract weight from product name');
  return { grams: 0, pieceCount: 0, source: 'unknown' };
}

/** "4.5 Gm (0.5 Gm + 2 Gm + 2 Gm)" → total = 4.5, pieces = count of additions */
function tryExplicitTotal(n: string): WeightResult | null {
  // Match: weight before a bracket that contains "+"
  const m = n.match(
    /(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b.*?\([^)]*\+[^)]*\)/i,
  );
  if (!m) return null;

  const total = parseFloat(m[1]);
  // Count pieces from the bracket content
  const bracket = n.match(/\(([^)]+)\)/);
  const pieces = bracket ? (bracket[1].match(/\+/g)?.length ?? 0) + 1 : 1;

  return { grams: total, pieceCount: pieces, source: 'explicit_total' };
}

/** "(1gm each x 5 Pcs)" → 1 × 5 = 5 */
function tryBracketMultiplication(n: string): WeightResult | null {
  const m = n.match(
    /\((\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\s*(?:each)?\s*x\s*(\d+)\s*Pcs?\)/i,
  );
  if (!m) return null;

  const perPiece = parseFloat(m[1]);
  const count = parseInt(m[2]);
  return { grams: perPiece * count, pieceCount: count, source: 'bracket_multiplication' };
}

/** "6Pcs 24KT Gold Coin - 2 g Each" → 6 × 2 = 12 */
function tryNPieces(n: string): WeightResult | null {
  // Pattern: N-Pcs/NPcs at start or in string, then weight + "Each" later
  const m = n.match(
    /(\d+)\s*[-]?\s*Pcs?\b.*?(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\s*(?:Each)?\b/i,
  );
  if (!m) return null;

  // Must have "Each" or "Pcs" to differentiate from single product
  if (!/each|pcs/i.test(n)) return null;

  const count = parseInt(m[1]);
  const perPiece = parseFloat(m[2]);

  // Sanity: if count is 1, it's not really a multi-piece
  if (count <= 1) return null;

  return { grams: perPiece * count, pieceCount: count, source: 'n_pieces' };
}

/** "Pack Of 3...5gm each" → 3 × 5 = 15, or "Set of 2 Gold Bar" */
function tryPackSet(n: string): WeightResult | null {
  const m = n.match(
    /(?:Pack\s*Of|Set\s*of)\s*(\d+)\b.*?(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/i,
  );
  if (!m) return null;

  const count = parseInt(m[1]);
  const weight = parseFloat(m[2]);

  // If "each" is present, it's per-piece; otherwise it might be total
  if (/each/i.test(n)) {
    return { grams: weight * count, pieceCount: count, source: 'pack_set' };
  }

  // If no "each", the weight might be total for the whole set
  // Check if there's a "+" pattern inside for individual weights
  if (/\+/.test(n)) return null; // let addition handler take over

  return { grams: weight * count, pieceCount: count, source: 'pack_set' };
}

/** "2 GM + 2 GM" → 4, "0.5 Gm + 2 Gm + 2 Gm" → 4.5 */
function tryAddition(n: string): WeightResult | null {
  // Must have at least one "+" with weight patterns around it
  if (!/\d\s*(?:g|gm|gms|gram|grams)\s*\+/i.test(n)) return null;

  const parts = n.match(
    /(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)/gi,
  );
  if (!parts || parts.length < 2) return null;

  // Only count parts that are separated by "+"
  // Split by "+" and extract weight from each segment
  const segments = n.split('+');
  let total = 0;
  let count = 0;

  for (const seg of segments) {
    const wm = seg.match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)/i);
    if (wm) {
      total += parseFloat(wm[1]);
      count++;
    }
  }

  if (count < 2) return null;
  return { grams: total, pieceCount: count, source: 'addition' };
}

/** "1 Gm", "2g", "20Gm", "0.5 gram", "0.25G" → simple weight */
function trySingleWeight(n: string): WeightResult | null {
  // Match weight followed by gram unit, with word boundary
  // Avoid matching purity numbers like "999", "916", "995", "750", "585"
  const purityNums = /^(999\.?9?|995|991|916|750|585|24|22|18|14)$/;

  // Find all potential weight matches
  const matches = [...n.matchAll(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/gi)];

  for (const m of matches) {
    const val = parseFloat(m[1]);
    const raw = m[1];

    // Skip if this looks like a purity value
    if (purityNums.test(raw)) continue;

    // Skip unreasonable weights (> 100g or 0)
    if (val <= 0 || val > 100) continue;

    return { grams: val, pieceCount: 1, source: 'single' };
  }

  // Fallback: try matching "- X g" or "X g" patterns at end
  const endMatch = n.match(/[-–]\s*(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\s*$/i);
  if (endMatch) {
    const val = parseFloat(endMatch[1]);
    if (val > 0 && val <= 100) {
      return { grams: val, pieceCount: 1, source: 'single' };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────
// PURITY PARSING
// ─────────────────────────────────────────────────

interface PurityResult {
  fineness: Fineness;
  karat: number;
  source: PuritySource;
}

function parsePurity(name: string, warnings: string[]): PurityResult {
  const n = name.replace(/\s+/g, ' ').trim();

  // 1. FINENESS IN BRACKETS: "(999.9+)", "(999)", "(995)", "(916)"
  const bracket = tryFinenessBracket(n);
  if (bracket) return bracket;

  // 2. FINENESS STANDALONE: "999 Purity", "999.9", standalone "999"
  const standalone = tryFinenessStandalone(n);
  if (standalone) return standalone;

  // 3. KARAT ONLY: "24K", "24KT", "22K", "22KT", "18K"
  const karat = tryKaratDefault(n);
  if (karat) return karat;

  // 4. NOT FOUND
  warnings.push('PURITY_UNPARSEABLE: Could not extract purity from product name');
  return { fineness: 999, karat: 24, source: 'unknown' };
}

/** "(999.9+)", "(999)", "(995)", "(916)" */
function tryFinenessBracket(n: string): PurityResult | null {
  const m = n.match(/\((\d{3}(?:\.\d+)?)\+?\)/);
  if (!m) return null;

  const val = parseFloat(m[1]);
  if (!VALID_FINENESS.has(val)) return null;

  return {
    fineness: val as Fineness,
    karat: finenessToKarat(val),
    source: 'fineness_bracket',
  };
}

/** "999 Purity", "999.9" standalone */
function tryFinenessStandalone(n: string): PurityResult | null {
  // Look for fineness values not inside brackets
  const m = n.match(/\b(999\.9|999|995|991|916|750|585)\b/);
  if (!m) return null;

  let val = parseFloat(m[1]);
  // 991 is rare, treat as 999 with warning
  if (val === 991) val = 999;

  if (!VALID_FINENESS.has(val)) return null;

  return {
    fineness: val as Fineness,
    karat: finenessToKarat(val),
    source: 'fineness_standalone',
  };
}

/** "24K", "24KT", "24Kt", "22K", "22KT" */
function tryKaratDefault(n: string): PurityResult | null {
  const m = n.match(/\b(24|22|18|14)\s*(?:K|KT|Kt)\b/i);
  if (!m) return null;

  const karat = parseInt(m[1]);
  const fineness = KARAT_TO_FINENESS[karat];
  if (!fineness) return null;

  return { fineness, karat, source: 'karat_default' };
}

function finenessToKarat(fineness: number): number {
  if (fineness >= 990) return 24;  // 999.9, 999, 995 are all 24K
  if (fineness >= 916) return 22;
  if (fineness >= 750) return 18;
  if (fineness >= 585) return 14;
  return 24;
}

// ─── Product Name Filters ───

const EXCLUDE_PATTERNS = [
  /platinum/i,
  /\bPt\b/,
  /silver/i,
  /\b925\b/,
  /idol/i,
  /pendant/i,
  /ring\b/i,
  /earring/i,
  /chain\b/i,
  /necklace/i,
  /bracelet/i,
  /bangle/i,
  /mangalsutra/i,
  /nosering/i,
];

const INCLUDE_PATTERNS = [
  /\bcoin\b/i,
  /\bbar\b/i,
  /\bbiscuit\b/i,
  /\bvedhani\b/i,     // 24K gold bands (P N Gadgil) — sold by weight like coins
];

/**
 * Check if a product should be tracked (gold coin/bar only).
 * Returns false for platinum, silver, jewellery, idols.
 */
export function shouldTrackProduct(name: string): boolean {
  // Must match at least one include pattern
  const included = INCLUDE_PATTERNS.some((p) => p.test(name));
  if (!included) return false;

  // Must not match any exclude pattern
  const excluded = EXCLUDE_PATTERNS.some((p) => p.test(name));
  return !excluded;
}

/**
 * Validate parsed data for sanity.
 * Returns warnings if data looks suspicious.
 */
export function validateParsedProduct(
  parsed: ParsedGoldData,
  price: number,
  name: string,
): string[] {
  const warnings: string[] = [];

  if (parsed.totalWeightGrams <= 0) {
    warnings.push('INVALID_WEIGHT: Weight is 0 or negative');
  }

  if (parsed.totalWeightGrams > 100) {
    warnings.push(`SUSPICIOUS_WEIGHT: ${parsed.totalWeightGrams}g seems too high`);
  }

  if (parsed.puritySource === 'unknown') {
    warnings.push('UNKNOWN_PURITY: Using default 999, may be inaccurate');
  }

  // Price per gram sanity check
  if (parsed.totalWeightGrams > 0) {
    const pricePerGram = price / parsed.totalWeightGrams;
    // Extremely loose bounds: ₹5,000 - ₹25,000 per gram
    if (pricePerGram < 5_000 || pricePerGram > 25_000) {
      warnings.push(
        `SUSPICIOUS_PRICE_PER_GRAM: ₹${Math.round(pricePerGram)}/gm. Likely mislabeled weight or multi-pack.`,
      );
    }
  }

  return warnings;
}
