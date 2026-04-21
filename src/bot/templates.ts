import type { Deal, DealStatus } from '../config/types.js';

/**
 * Format a deal as a Telegram message.
 *
 * Layout:
 *   Status line
 *   Product name / Brand / Platform
 *   Weight / Purity
 *
 *   💰 Listed Price: ₹X,XXX
 *   🎫 Promo (CODE): -₹XXX
 *   🏦 Best Prepaid Offer: -₹XXX (Bank, UPI/Card)
 *   💵 Final Price: ₹X,XXX
 *
 *   📉 IBJA Rate + Market Value
 *   ✅ Savings line
 *
 *   🏦 Other Offers:
 *     • Bank2: -₹XXX (Card)
 *     • Bank3: -₹XXX (UPI)
 *
 *   Affiliate link
 *   Timestamp
 */
export function formatDealMessage(
  deal: Deal,
  affiliateUrl: string,
  status: DealStatus | 'price_drop' | 'better_offer' | 'deal_back' = 'active',
): string {
  const { product, marketValue, totalSavings, totalSavingsPct, ibjaRate, ibjaSession } = deal;

  const statusLine = getStatusLine(status);
  const platformLabel = product.platform === 'ajio' ? 'Ajio' : 'Myntra';
  const comboLabel = product.isCombo ? ` (${product.pieceCount} pcs)` : '';
  const purityLabel = product.fineness === 999.9 ? '24K (999.9)' :
    product.karat === 24 ? `24K (${product.fineness})` : `${product.karat}K (${product.fineness})`;

  const lines: string[] = [
    statusLine,
    '',
    `📦 ${product.name}`,
    `🏪 ${platformLabel} | ${product.brand}`,
    `⚖️ ${product.totalWeightGrams}g ${purityLabel}${comboLabel}`,
    '',
  ];

  // ─── Price Breakdown ───

  // Listed price (the selling price on the product page, before promo codes)
  lines.push(`💰 Listed Price: ${fmtRs(product.sellingPrice)}`);

  // Show MRP strikethrough if different
  if (product.mrp > product.sellingPrice) {
    lines.push(`   (MRP ${fmtRs(product.mrp)}, ${Math.round((1 - product.sellingPrice / product.mrp) * 100)}% OFF)`);
  }

  // Promo discount
  if (deal.promoSavings > 0) {
    const promoLabel = deal.appliedPromoCode ? ` (${deal.appliedPromoCode})` : '';
    lines.push(`🎫 Promo${promoLabel}: -${fmtRs(deal.promoSavings)}`);
  }

  // Best prepaid/bank offer (top 1) — full description
  if (deal.topBankOffers.length > 0) {
    const top = deal.topBankOffers[0];
    lines.push(`🏦 ${top.offer.bankName}: -${fmtRs(top.savings)}`);
    lines.push(`   ${top.offer.description}`);
  }

  // Final price after all discounts
  if (deal.finalPrice < product.effectivePrice) {
    lines.push(`💵 Final Price: ${fmtRs(deal.finalPrice)}`);
  }

  lines.push('');

  // ─── Market Comparison ───
  lines.push(`📉 IBJA ${ibjaSession} Rate: ${fmtRs(ibjaRate)}/gm (${purityLabel})`);
  lines.push(`📊 Market Value: ${fmtRs(marketValue)}`);
  lines.push(`✅ You Save: ${fmtRs(totalSavings)} (${totalSavingsPct.toFixed(1)}%)${totalSavingsPct >= 5 ? ' 🔥' : ''}`);

  // ─── Other Bank Offers (2nd & 3rd) ───
  if (deal.topBankOffers.length > 1) {
    lines.push('');
    lines.push('🏦 Other Offers:');
    for (let i = 1; i < deal.topBankOffers.length; i++) {
      const bo = deal.topBankOffers[i];
      const instruments = formatInstruments(bo.offer.eligiblePaymentInstruments);
      lines.push(`  • ${bo.offer.bankName}: -${fmtRs(bo.savings)}${instruments ? ` (${instruments})` : ''}`);
    }
  }

  lines.push('');
  lines.push(affiliateUrl);
  lines.push(`⏰ ${formatTime(deal.detectedAt)}`);

  return lines.join('\n');
}

/**
 * Format an expired/OOS deal message (for editing existing messages).
 */
export function formatExpiredMessage(
  deal: Deal,
  reason: 'expired' | 'oos',
  activeFrom: number,
): string {
  const { product } = deal;
  const platformLabel = product.platform === 'ajio' ? 'Ajio' : 'Myntra';
  const statusEmoji = reason === 'oos' ? '⚫' : '🔴';
  const statusText = reason === 'oos' ? 'OUT OF STOCK' : 'DEAL EXPIRED';

  const duration = formatDuration(Date.now() - activeFrom);

  const lines = [
    `${statusEmoji} ${statusText}`,
    '',
    `📦 ${product.name}`,
    `🏪 ${platformLabel} | ${product.brand}`,
    '',
    reason === 'expired'
      ? `💰 Price: ${fmtRs(product.effectivePrice)} (now above market)`
      : `💰 Last Price: ${fmtRs(product.effectivePrice)}`,
    `📉 Market Value: ${fmtRs(deal.marketValue)}`,
    '',
    `⏰ Was active for ${duration}`,
  ];

  return lines.join('\n');
}

/**
 * Format a gold rate summary message.
 */
export function formatGoldRateMessage(
  date: string,
  session: 'AM' | 'PM',
  rates: Record<number, number>,
): string {
  const lines = [
    `📊 IBJA Gold Rates — ${date} (${session})`,
    '',
    `🥇 24K (999): ${fmtRs(rates[999])}/gm`,
    `🥇 24K (995): ${fmtRs(rates[995])}/gm`,
    `🥈 22K (916): ${fmtRs(rates[916])}/gm`,
    `🥉 18K (750): ${fmtRs(rates[750])}/gm`,
  ];

  return lines.join('\n');
}

/**
 * Number of deals per page in /deals pagination.
 */
export const DEALS_PAGE_SIZE = 5;

/**
 * Format a deals summary (for /deals command).
 * Shows a page of deals with pagination info.
 */
export function formatDealsSummary(deals: Deal[], page = 0): string {
  if (deals.length === 0) {
    return '📋 No active gold deals right now.\n\nI\'m scanning Myntra & Ajio every few minutes. You\'ll be notified when a deal appears!';
  }

  const totalPages = Math.ceil(deals.length / DEALS_PAGE_SIZE);
  const start = page * DEALS_PAGE_SIZE;
  const end = Math.min(start + DEALS_PAGE_SIZE, deals.length);
  const pageDeals = deals.slice(start, end);

  const lines = [
    `📋 Gold Deals (${start + 1}–${end} of ${deals.length})  •  Page ${page + 1}/${totalPages}`,
    '',
  ];

  for (const deal of pageDeals) {
    const platform = deal.product.platform === 'ajio' ? 'Ajio' : 'Myntra';
    const purityLabel = deal.product.karat === 24 ? '24K' : `${deal.product.karat}K`;
    const fire = deal.totalSavingsPct >= 5 ? '🔥' : '✅';

    lines.push(
      `${fire} ${deal.product.brand} ${deal.product.totalWeightGrams}g ${purityLabel} — ${platform}`,
    );

    // Show listed price and final price
    if (deal.finalPrice < deal.product.sellingPrice) {
      lines.push(
        `   ${fmtRs(deal.product.sellingPrice)} → ${fmtRs(deal.finalPrice)} (Save ${fmtRs(deal.totalSavings)}, ${deal.totalSavingsPct.toFixed(1)}%)`,
      );
    } else {
      lines.push(
        `   ${fmtRs(deal.finalPrice)} (Save ${fmtRs(deal.totalSavings)}, ${deal.totalSavingsPct.toFixed(1)}%)`,
      );
    }

    // Promo coupon code
    if (deal.promoSavings > 0 && deal.appliedPromoCode) {
      lines.push(`   🎫 Use code: ${deal.appliedPromoCode} (-${fmtRs(deal.promoSavings)})`);
    }

    // Top 1 bank offer — full description
    if (deal.topBankOffers.length > 0) {
      const top = deal.topBankOffers[0];
      lines.push(`   🏦 ${top.offer.description}`);
    }

    lines.push(`   ${deal.affiliateUrl || deal.product.url}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Status Line Helpers ───

function getStatusLine(status: DealStatus | 'price_drop' | 'better_offer' | 'deal_back'): string {
  switch (status) {
    case 'active': return '🟢 GOLD DEAL FOUND';
    case 'price_drop': return '🟢 GOLD DEAL — ⬇️ Price dropped!';
    case 'better_offer': return '🟢 GOLD DEAL — 🎫 Better offer available!';
    case 'deal_back': return '🟢 DEAL IS BACK! 🔄';
    case 'expired': return '🔴 DEAL EXPIRED';
    case 'oos': return '⚫ OUT OF STOCK';
    default: return '🟢 GOLD DEAL';
  }
}

// ─── Formatting Helpers ───

/**
 * Format payment instruments into a short readable label.
 */
function formatInstruments(instruments: string[]): string {
  if (!instruments || instruments.length === 0) return '';
  const labels = instruments.map((i) => {
    switch (i) {
      case 'UPI': return 'UPI';
      case 'WALLET': return 'Wallet';
      case 'CARD':
      case 'SAVED_CARD': return 'Card';
      case 'NET_BANKING': return 'NetBanking';
      default: return i;
    }
  });
  // Deduplicate
  return [...new Set(labels)].join('/');
}

function fmtRs(amount: number): string {
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
