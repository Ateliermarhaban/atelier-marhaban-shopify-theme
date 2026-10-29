import crypto from 'node:crypto';
import { config } from './config.js';

const BASE = `https://${config.shopify.shop}/admin/api/${config.shopify.apiVersion}`;

// --- Authenticatie ---
// Ofwel een vast access token (SHOPIFY_ACCESS_TOKEN), ofwel client_credentials:
// met SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET vragen we per proces een token aan
// via /admin/oauth/access_token. Dat token is ~24u geldig; we cachen het in-memory
// voor de duur van deze run.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (config.shopify.accessToken) return config.shopify.accessToken;

  if (cachedToken && Date.now() < cachedTokenExpiry - 60000) return cachedToken;

  if (!config.shopify.clientId || !config.shopify.clientSecret) {
    throw new Error(
      'Geen Shopify-authenticatie: zet SHOPIFY_ACCESS_TOKEN, of SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.'
    );
  }

  const res = await fetch(`https://${config.shopify.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token-aanvraag (client_credentials) faalde (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000);
  return cachedToken;
}

// Low-level request met retry op rate-limiting (429). Geeft json + de Link-header
// terug (die Link-header gebruiken we voor cursor-paginatie).
async function shopifyRequest(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API ${method} ${path} faalde (${res.status}): ${text}`);
    }
    const link = res.headers.get('link');
    const json = res.status === 204 ? null : await res.json();
    return { json, link };
  }
  throw new Error(`Shopify API ${method} ${path}: te vaak rate-limited (429).`);
}

async function shopifyFetch(path, opts = {}) {
  const { json } = await shopifyRequest(path, opts);
  return json;
}

// Haalt het page_info-cursorteken uit een Link-header (rel="next"), of null.
function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader.split(',').find((s) => s.includes('rel="next"'));
  if (!next) return null;
  const url = next.match(/<([^>]+)>/);
  if (!url) return null;
  try {
    return new URL(url[1]).searchParams.get('page_info');
  } catch {
    return null;
  }
}

/**
 * Verifieer de HMAC-handtekening van een Shopify-webhook.
 * rawBody is de onbewerkte request body (Buffer/string), hmacHeader is X-Shopify-Hmac-Sha256.
 */
export function verifyWebhook(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret || !hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

/**
 * Zoek het inventory_item_id op dat bij een SKU hoort.
 */
export async function findInventoryItemBySku(sku) {
  const data = await shopifyFetch(`/variants.json?sku=${encodeURIComponent(sku)}`);
  // variants.json filtert niet altijd server-side op sku; dubbel checken.
  const variant = (data.variants || []).find((v) => v.sku === sku);
  return variant ? variant.inventory_item_id : null;
}

/**
 * Zet de absolute beschikbare voorraad voor een SKU op de geconfigureerde location.
 */
export async function setAvailableQty(sku, qty) {
  const inventoryItemId = await findInventoryItemBySku(sku);
  if (!inventoryItemId) {
    throw new Error(`Geen Shopify-variant gevonden voor SKU "${sku}".`);
  }
  if (!config.shopify.locationId) {
    throw new Error('SHOPIFY_LOCATION_ID is niet ingesteld.');
  }
  await shopifyFetch('/inventory_levels/set.json', {
    method: 'POST',
    body: {
      location_id: Number(config.shopify.locationId),
      inventory_item_id: inventoryItemId,
      available: qty,
    },
  });
  return qty;
}

/**
 * Haal de huidige beschikbare voorraad voor een SKU op (voor loop-guard/vergelijking).
 */
export async function getAvailableQty(sku) {
  const inventoryItemId = await findInventoryItemBySku(sku);
  if (!inventoryItemId) return null;
  const data = await shopifyFetch(
    `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${config.shopify.locationId}`
  );
  const level = (data.inventory_levels || [])[0];
  return level ? level.available : null;
}

// --- Functies voor de gratis batch-variant (GitHub Actions cron) ---

/**
 * Alle Shopify-varianten met een SKU, inclusief hun inventory_item_id.
 * Volgt cursor-paginatie tot alle producten doorlopen zijn.
 */
export async function listAllVariantsWithSku() {
  const out = [];
  let path = `/products.json?limit=250`;
  while (path) {
    const { json, link } = await shopifyRequest(path);
    for (const product of json.products || []) {
      for (const variant of product.variants || []) {
        if (variant.sku) {
          out.push({ sku: variant.sku, inventoryItemId: variant.inventory_item_id });
        }
      }
    }
    const next = parseNextPageInfo(link);
    path = next ? `/products.json?limit=250&page_info=${next}` : null;
  }
  return out;
}

/**
 * Recente orders die nog niet het label `syncedTag` dragen (dus nog niet in Odoo
 * verwerkt). Het label dient als dedup-markering, zodat we zonder externe opslag
 * elke order precies één keer verwerken.
 */
export async function listUnsyncedOrders({ sinceDays = 7, syncedTag = 'odoo-synced' } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const out = [];
  let path = `/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}`;
  while (path) {
    const { json, link } = await shopifyRequest(path);
    for (const order of json.orders || []) {
      const tags = (order.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!tags.includes(syncedTag)) out.push(order);
    }
    const next = parseNextPageInfo(link);
    path = next ? `/orders.json?limit=250&page_info=${next}` : null;
  }
  return out;
}

/**
 * Zet het dedup-label op een order zodat een volgende run hem overslaat.
 */
export async function tagOrderSynced(order, syncedTag = 'odoo-synced') {
  const tags = (order.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.includes(syncedTag)) return;
  tags.push(syncedTag);
  await shopifyFetch(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: { order: { id: order.id, tags: tags.join(', ') } },
  });
}

/**
 * Beschikbare voorraad lezen/zetten rechtstreeks op inventory_item_id
 * (scheelt een extra SKU-lookup in de batch).
 */
export async function getAvailableByItem(inventoryItemId) {
  const data = await shopifyFetch(
    `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${config.shopify.locationId}`
  );
  const level = (data.inventory_levels || [])[0];
  return level ? level.available : null;
}

export async function setAvailableByItem(inventoryItemId, qty) {
  if (!config.shopify.locationId) {
    throw new Error('SHOPIFY_LOCATION_ID is niet ingesteld.');
  }
  await shopifyFetch('/inventory_levels/set.json', {
    method: 'POST',
    body: {
      location_id: Number(config.shopify.locationId),
      inventory_item_id: inventoryItemId,
      available: qty,
    },
  });
  return qty;
}

export { shopifyFetch };
