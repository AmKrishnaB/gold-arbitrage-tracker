import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

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
        const res = await axios.post(
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

        logger.debug(
          { status: res.status, data: JSON.stringify(res.data).slice(0, 500), inputUrl: productUrl },
          'EarnKaro: raw API response',
        );

        return res.data;
      },
      { retries: 2, delayMs: 1000, label: 'EarnKaro' },
    );

    // Check all possible URL fields the API might return
    const affiliateUrl = result.long_url || result.longUrl || result.url || result.link
      || result.affiliate_url || result.converted_url || result.short_url
      || (result.data && typeof result.data === 'string' ? result.data : null)
      || (result.data?.long_url) || (result.data?.url);

    if (affiliateUrl) {
      logger.debug({ original: productUrl, affiliate: affiliateUrl }, 'EarnKaro: link generated');
      return affiliateUrl;
    }

    logger.warn(
      { responseKeys: Object.keys(result), response: JSON.stringify(result).slice(0, 300) },
      'EarnKaro: no affiliate URL found in response',
    );
    return productUrl;
  } catch (err) {
    const axiosErr = err as any;
    const responseData = axiosErr?.response?.data;
    logger.error(
      {
        error: (err as Error).message,
        url: productUrl,
        httpStatus: axiosErr?.response?.status,
        responseData: responseData ? JSON.stringify(responseData).slice(0, 300) : undefined,
      },
      'EarnKaro: link generation failed',
    );
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
