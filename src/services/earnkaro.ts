import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

interface EarnKaroResponse {
  status: string;
  long_url?: string;
  message?: string;
}

/**
 * Generate an EarnKaro affiliate link for a product URL.
 */
export async function generateAffiliateLink(productUrl: string): Promise<string> {
  if (!config.earnkaroApiKey) {
    logger.warn('EarnKaro API key not configured, returning original URL');
    return productUrl;
  }

  try {
    const result = await retry(
      async () => {
        const res = await axios.post<EarnKaroResponse>(
          'https://ekaro-api.affiliaters.in/api/converter/public',
          {
            deal: productUrl,
            convert_option: 'convert_only',
          },
          {
            headers: {
              'Authorization': `Bearer ${config.earnkaroApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 10_000,
          },
        );
        return res.data;
      },
      { retries: 2, delayMs: 1000, label: 'EarnKaro' },
    );

    if (result.long_url) {
      return result.long_url;
    }

    logger.warn({ status: result.status, message: result.message }, 'EarnKaro: no link returned');
    return productUrl;
  } catch (err) {
    logger.error({ error: (err as Error).message, url: productUrl }, 'EarnKaro: link generation failed');
    return productUrl;
  }
}

/**
 * Batch generate affiliate links for multiple URLs.
 * Processes sequentially to avoid rate limits.
 */
export async function generateAffiliateLinks(
  urls: Map<string, string>, // productId → productUrl
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const [id, url] of urls) {
    const affiliateUrl = await generateAffiliateLink(url);
    result.set(id, affiliateUrl);

    // Small delay between requests
    await new Promise((r) => setTimeout(r, 200));
  }

  return result;
}
