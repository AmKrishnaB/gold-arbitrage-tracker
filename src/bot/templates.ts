import type { Deal, DealStatus } from '../config/types.js';

/**
 * Format a deal as a Telegram message.
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

  // Price breakdown
  if (product.mrp !== product.sellingPrice) {
    lines.push(`💰 MRP: ${fmtRs(product.mrp)} → ${fmtRs(product.sellingPrice)} (${product.discountPercent}% OFF)`);
  } else {
    lines.push(`💰 Price: ${fmtRs(product.sellingPrice)}`);
  }

  if (product.offerPrice && product.offerPrice < product.sellingPrice) {
    lines.push(`🏷️ Offer Price: ${fmtRs(product.offerPrice)}`);
  }

  if (product.couponPrice) {
    lines.push(`🎫 Coupon Price: ${fmtRs(product.couponPrice)} (apply coupon on ${platformLabel})`);
  }

  // Ajio promo + bank offer
  if (deal.promoSavings > 0) {
    const promo = deal.product.platform === 'ajio' ? '(apply at checkout)' : '';
    lines.push(`🎫 Promo Savings: -${fmtRs(deal.promoSavings)} ${promo}`);
  }

  if (deal.bankOfferSavings > 0 && deal.bestBankOffer) {
    lines.push(`🏦 ${deal.bestBankOffer.bankName}: -${fmtRs(deal.bankOfferSavings)}`);
  }

  if (deal.finalPrice < deal.effectivePrice) {
    lines.push(`💵 Best Price: ${fmtRs(deal.finalPrice)}`);
  }

  lines.push('');
  lines.push(`📉 IBJA ${ibjaSession} Rate: ${fmtRs(ibjaRate)}/gm (${purityLabel})`);
  lines.push(`📊 Market Value: ${fmtRs(marketValue)}`);
  lines.push(`✅ You Save: ${fmtRs(totalSavings)} (${totalSavingsPct.toFixed(1)}%)${totalSavingsPct >= 5 ? ' 🔥' : ''}`);
  lines.push('');
  lines.push(`🔗 Buy Now: ${affiliateUrl}`);
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
 * Format a deals summary (for /deals command).
 */
export function formatDealsSummary(deals: Deal[]): string {
  if (deals.length === 0) {
    return '📋 No active gold deals right now.\n\nI\'m scanning Myntra & Ajio every few minutes. You\'ll be notified when a deal appears!';
  }

  const lines = [
    `📋 Active Gold Deals (${deals.length})`,
    '',
  ];

  for (const deal of deals.slice(0, 10)) {
    const platform = deal.product.platform === 'ajio' ? 'Ajio' : 'Myntra';
    lines.push(
      `${deal.totalSavingsPct >= 5 ? '🔥' : '✅'} ${deal.product.brand} ${deal.product.totalWeightGrams}g ${deal.product.karat}K — ${platform}`,
    );
    lines.push(
      `   ${fmtRs(deal.finalPrice)} (Save ${fmtRs(deal.totalSavings)}, ${deal.totalSavingsPct.toFixed(1)}%)`,
    );
    lines.push('');
  }

  if (deals.length > 10) {
    lines.push(`... and ${deals.length - 10} more deals`);
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
