import crypto from 'node:crypto';
import { config } from './config.js';

const BASE = `https://${config.shopify.shop}/admin/api/${config.shopify.apiVersion}`;

async function shopifyFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': config.shopify.accessToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${method} ${path} faalde (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
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

export { shopifyFetch };
