# Myntra API Proxy — Cloudflare Worker

Proxies requests to Myntra's API via Cloudflare's edge network, bypassing datacenter IP blocking.

## Setup (one-time, ~5 minutes)

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```
This opens a browser to authenticate. If you don't have a Cloudflare account, create one free at https://dash.cloudflare.com/sign-up

### 3. Deploy the Worker
```bash
cd cf-worker
npx wrangler deploy
```
This outputs your Worker URL, e.g.: `https://myntra-proxy.your-subdomain.workers.dev`

### 4. Set the auth secret
```bash
npx wrangler secret put AUTH_SECRET
```
Enter a random string (e.g. generate with `openssl rand -hex 32`).

### 5. Configure your tracker
Add to your `.env` file:
```
CF_WORKER_URL=https://myntra-proxy.your-subdomain.workers.dev/proxy
CF_WORKER_SECRET=your-secret-from-step-4
```

## How it works

```
Your VPS (Oracle Cloud)
    |
    | POST /proxy { url, headers, body }
    v
Cloudflare Worker (edge IP, non-datacenter)
    |
    | Forward request with Myntra headers
    v
api.myntra.com (sees CF edge IP, not blocked)
    |
    | Response
    v
CF Worker → Your VPS
```

## Free tier limits

- **100,000 requests/day** (free)
- Scanning every 5 min = ~288 requests/day (well within limits)
- 10ms CPU time per request (more than enough for proxying)
