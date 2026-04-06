import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { logger } from '../utils/logger.js';

// ─── Types ───

interface ProxiflyProxy {
  proxy: string;        // e.g. "http://1.2.3.4:8080" or "socks5://1.2.3.4:1080"
  protocol: string;     // http | socks4 | socks5
  ip: string;
  port: number;
  https: boolean;
  anonymity: string;    // transparent | anonymous | elite
  score: number;
  geolocation: {
    country: string;
    city: string;
  };
}

interface PoolEntry {
  proxy: ProxiflyProxy;
  failures: number;
  lastUsed: number;
  lastFailed: number;
  blocked: boolean;
}

// ─── Constants ───

// Proxifly CDN URLs — updated every 5 min, no rate limits
const PROXIFLY_INDIA_CDN =
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/IN/data.json';

const MAX_FAILURES = 3;
const REFRESH_INTERVAL_MS = 30 * 60_000; // Refresh every 30 min

// ─── Pool State ───

let pool: PoolEntry[] = [];
let lastRefresh = 0;
let currentIndex = 0;
let isRefreshing = false;

// ─── Fetcher ───

/**
 * Fetch Indian proxies from Proxifly's free CDN (no rate limits).
 * The list is refreshed upstream every 5 minutes with verified working proxies.
 */
async function fetchIndianProxies(): Promise<ProxiflyProxy[]> {
  try {
    const { data } = await axios.get<ProxiflyProxy[]>(PROXIFLY_INDIA_CDN, {
      timeout: 10_000,
    });
    logger.info({ count: data.length }, 'ProxyPool: fetched Indian proxies from Proxifly CDN');
    return data;
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'ProxyPool: failed to fetch Indian proxies');
    return [];
  }
}

/**
 * Rank proxies: prefer HTTPS-capable, higher anonymity, SOCKS5 > HTTP.
 */
function rankProxies(proxies: ProxiflyProxy[]): ProxiflyProxy[] {
  const anonScore = (a: string) =>
    a === 'elite' ? 3 : a === 'anonymous' ? 2 : 1;
  const protoScore = (p: string) =>
    p === 'socks5' ? 3 : p === 'socks4' ? 2 : 1;

  return [...proxies].sort((a, b) => {
    if (a.https !== b.https) return a.https ? -1 : 1;
    const aAnon = anonScore(a.anonymity);
    const bAnon = anonScore(b.anonymity);
    if (aAnon !== bAnon) return bAnon - aAnon;
    return protoScore(b.protocol) - protoScore(a.protocol);
  });
}

// ─── Public API ───

/**
 * Initialize or refresh the proxy pool.
 * Call before starting a Myntra scan cycle.
 */
export async function refreshProxyPool(): Promise<number> {
  if (isRefreshing) return pool.filter((e) => !e.blocked).length;
  isRefreshing = true;

  try {
    const raw = await fetchIndianProxies();
    if (raw.length === 0) {
      logger.warn('ProxyPool: no proxies fetched, keeping existing pool');
      return pool.filter((e) => !e.blocked).length;
    }

    const ranked = rankProxies(raw);
    pool = ranked.map((proxy) => ({
      proxy,
      failures: 0,
      lastUsed: 0,
      lastFailed: 0,
      blocked: false,
    }));
    currentIndex = 0;
    lastRefresh = Date.now();

    logger.info({ poolSize: pool.length }, 'ProxyPool: refreshed');
    return pool.length;
  } finally {
    isRefreshing = false;
  }
}

/**
 * Check if pool needs refresh (stale or empty).
 */
export function needsRefresh(): boolean {
  if (pool.length === 0) return true;
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) return true;
  if (pool.every((e) => e.blocked)) return true;
  return false;
}

/**
 * Get the next available proxy agent for axios.
 * Returns null if no proxies available.
 */
export function getNextProxy(): {
  agent: HttpsProxyAgent<string> | SocksProxyAgent;
  proxyUrl: string;
  index: number;
} | null {
  if (pool.length === 0) return null;

  const alive = pool.filter((e) => !e.blocked);
  if (alive.length === 0) return null;

  // Round-robin through alive proxies
  let attempts = 0;
  while (attempts < pool.length) {
    const entry = pool[currentIndex % pool.length];
    currentIndex = (currentIndex + 1) % pool.length;
    attempts++;

    if (entry.blocked) continue;

    const proxyUrl = entry.proxy.proxy;
    const agent = createAgentFromUrl(proxyUrl, entry.proxy.protocol);
    if (agent) {
      entry.lastUsed = Date.now();
      return { agent, proxyUrl, index: pool.indexOf(entry) };
    }
  }

  return null;
}

/**
 * Mark a proxy as failed. After MAX_FAILURES consecutive, it's blocked.
 */
export function markProxyFailed(index: number): void {
  if (index < 0 || index >= pool.length) return;
  const entry = pool[index];
  entry.failures++;
  entry.lastFailed = Date.now();

  if (entry.failures >= MAX_FAILURES) {
    entry.blocked = true;
    const aliveCount = pool.filter((e) => !e.blocked).length;
    logger.debug(
      { proxy: entry.proxy.ip, failures: entry.failures, remaining: aliveCount },
      'ProxyPool: proxy blocked after max failures',
    );
  }
}

/**
 * Mark a proxy as successful (reset failure count).
 */
export function markProxySuccess(index: number): void {
  if (index < 0 || index >= pool.length) return;
  pool[index].failures = 0;
}

/**
 * Get pool stats for /status command.
 */
export function getPoolStats(): {
  total: number;
  alive: number;
  blocked: number;
  lastRefreshAgo: number;
} {
  return {
    total: pool.length,
    alive: pool.filter((e) => !e.blocked).length,
    blocked: pool.filter((e) => e.blocked).length,
    lastRefreshAgo: lastRefresh > 0 ? Date.now() - lastRefresh : -1,
  };
}

// ─── Internal ───

function createAgentFromUrl(
  proxyUrl: string,
  protocol: string,
): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
  try {
    if (protocol === 'socks4' || protocol === 'socks5') {
      return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    logger.debug({ proxyUrl, error: (err as Error).message }, 'ProxyPool: failed to create agent');
    return undefined;
  }
}
