/**
 * Cloudflare Worker — Myntra API Proxy
 *
 * Forwards requests from your VPS to Myntra's API via Cloudflare's edge network.
 * CF edge IPs are not flagged as datacenter, bypassing Myntra's IP-based blocking.
 *
 * Deploy: npx wrangler deploy
 * Usage:  POST https://your-worker.your-subdomain.workers.dev/proxy
 *         Body: { "url": "https://api.myntra.com/...", "body": {...} }
 *
 * Security: Requests must include the AUTH_SECRET header to prevent abuse.
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Secret',
        },
      });
    }

    // Only accept POST to /proxy
    const url = new URL(request.url);
    if (url.pathname !== '/proxy' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Auth check — prevent random people from using your proxy
    const authSecret = request.headers.get('X-Auth-Secret');
    if (env.AUTH_SECRET && authSecret !== env.AUTH_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const payload = await request.json();
      const targetUrl = payload.url;
      const targetBody = payload.body;
      const targetHeaders = payload.headers || {};

      if (!targetUrl || !targetUrl.startsWith('https://api.myntra.com')) {
        return new Response(
          JSON.stringify({ error: 'Only api.myntra.com URLs allowed' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Sanitize URL — pagination URIs from Myntra contain unencoded {, }, "
      // which are invalid in URLs and cause fetch() to reject them
      const sanitizedUrl = targetUrl
        .replace(/{/g, '%7B')
        .replace(/}/g, '%7D')
        .replace(/"/g, '%22')
        .replace(/\|/g, '%7C');

      // Forward request to Myntra from CF edge
      const myntraResponse = await fetch(sanitizedUrl, {
        method: payload.method || 'POST',
        headers: {
          ...targetHeaders,
        },
        body: targetBody ? JSON.stringify(targetBody) : undefined,
      });

      // Stream the response back
      const responseBody = await myntraResponse.text();

      return new Response(responseBody, {
        status: myntraResponse.status,
        headers: {
          'Content-Type': myntraResponse.headers.get('Content-Type') || 'application/json',
          'X-Proxy-Status': myntraResponse.status.toString(),
          'X-Proxy-Target': targetUrl,
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Proxy error', message: err.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};
