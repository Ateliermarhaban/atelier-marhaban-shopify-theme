import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';
import { markSynced, wasJustSynced } from './state.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Richting 1: Shopify-verkoop (webshop of POS) -> verlaag voorraad in Odoo.
 * Wordt aangeroepen vanuit de orders/create webhook.
 */
export async function applyShopifySaleToOdoo(order) {
  const lineItems = order.line_items || [];
  for (const item of lineItems) {
    const sku = item.sku;
    const qty = item.quantity;
    if (!sku) {
      log(`[shopify->odoo] Order ${order.id}: regel zonder SKU overgeslagen (${item.title}).`);
      continue;
    }
    try {
      if (config.service.dryRun) {
        log(`[shopify->odoo][DRY] Zou Odoo verlagen: ${sku} -${qty}`);
        continue;
      }
      const newQty = await odoo.adjustOnHandQty(sku, -qty);
      // Odoo is leidend: na deze aanpassing herberekent de poller de Shopify-
      // available op basis van free_qty en open offertes. Niet als echo markeren.
      log(`[shopify->odoo] ${sku}: -${qty} -> Odoo on-hand = ${newQty}`);
    } catch (err) {
      log(`[shopify->odoo] FOUT voor SKU ${sku}:`, err.message);
    }
  }
}

/**
 * Richting 2: Odoo -> Shopify.
 * Voor elke kandidaat-SKU wordt de te tonen Shopify-voorraad herberekend als:
 *
 *     available = Odoo free_qty  -  gereserveerd door open (niet-verlopen) offertes
 *
 * - Een open offerte verlaagt available (reservering).
 * - Zodra de offerte-validity_date verstreken is, valt ze uit `reservations`,
 *   waardoor available vanzelf weer stijgt (automatisch terug open).
 * - Odoo is leidend: free_qty verrekent bevestigde orders en leveringen.
 *
 * `reservations` is een Map SKU -> gereserveerd aantal (uit open offertes).
 */
export async function syncAvailableForSkus(skus, reservations) {
  for (const sku of skus) {
    try {
      const free = await odoo.getFreeQty(sku);
      if (free === null) {
        log(`[odoo->shopify] ${sku}: niet gevonden in Odoo, overgeslagen.`);
        continue;
      }
      const reserved = reservations.get(sku) || 0;
      const available = Math.max(0, free - reserved);

      if (wasJustSynced(sku, available)) {
        continue; // echo van onze eigen schrijfactie
      }
      if (config.service.dryRun) {
        log(`[odoo->shopify][DRY] ${sku}: free=${free} - res=${reserved} => available=${available}`);
        continue;
      }
      const current = await shopify.getAvailableQty(sku);
      if (current === available) {
        continue; // al gelijk, geen schrijfactie nodig
      }
      await shopify.setAvailableQty(sku, available);
      markSynced(sku, available);
      log(`[odoo->shopify] ${sku}: available = ${available} (free ${free} - res ${reserved}, was ${current}).`);
    } catch (err) {
      log(`[odoo->shopify] FOUT voor SKU ${sku}:`, err.message);
    }
  }
}

export { log };
