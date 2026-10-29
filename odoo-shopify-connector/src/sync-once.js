// Batch-sync in één run — bedoeld voor de gratis GitHub Actions-cron.
// Doet beide richtingen door te pollen en stopt daarna (geen server nodig).
//
//   1. Shopify -> Odoo: nieuwe (ongelabelde) orders verlagen Odoo, en krijgen
//      daarna het label 'odoo-synced' zodat ze niet dubbel geteld worden.
//   2. Odoo -> Shopify: per SKU available = free_qty - open-offerte-reservering,
//      en Shopify wordt gelijkgezet. Idempotent en zelfherstellend.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const SYNCED_TAG = 'odoo-synced';

/** Richting 1: Shopify-verkopen (web/POS) verwerken in Odoo. */
async function shopifyToOdoo() {
  const orders = await shopify.listUnsyncedOrders({ sinceDays: 7, syncedTag: SYNCED_TAG });
  log(`[shopify->odoo] ${orders.length} nieuwe order(s) te verwerken.`);

  for (const order of orders) {
    let allOk = true;
    for (const item of order.line_items || []) {
      if (!item.sku) {
        log(`[shopify->odoo] Order ${order.id}: regel zonder SKU overgeslagen (${item.title}).`);
        continue;
      }
      try {
        if (config.service.dryRun) {
          log(`[shopify->odoo][DRY] ${item.sku} -${item.quantity}`);
          continue;
        }
        const newQty = await odoo.adjustOnHandQty(item.sku, -item.quantity);
        log(`[shopify->odoo] ${item.sku}: -${item.quantity} -> Odoo on-hand = ${newQty}`);
      } catch (err) {
        allOk = false;
        log(`[shopify->odoo] FOUT voor SKU ${item.sku} (order ${order.id}):`, err.message);
      }
    }
    // Alleen labelen als de volledige order verwerkt is, anders volgende run opnieuw.
    if (allOk && !config.service.dryRun) {
      await shopify.tagOrderSynced(order, SYNCED_TAG);
      log(`[shopify->odoo] Order ${order.id} gelabeld als '${SYNCED_TAG}'.`);
    }
  }
}

/** Richting 2: Odoo-voorraad (incl. offerte-reserveringen) naar Shopify.
 *  Bulk-aanpak: Odoo free_qty en Shopify-niveaus worden in enkele calls opgehaald
 *  en in het geheugen vergeleken; alleen afwijkingen worden weggeschreven. */
async function odooToShopify() {
  const [reservations, variants, freeBySku] = await Promise.all([
    odoo.getOpenQuotationReservations(),
    shopify.listAllVariantsWithSku(),
    odoo.getAllFreeQtyBySku(),
  ]);
  const levels = await shopify.getAvailableLevelsBulk(variants.map((v) => v.inventoryItemId));
  log(`[odoo->shopify] ${variants.length} Shopify-variant(en); ${freeBySku.size} Odoo-SKU('s); ${reservations.size} gereserveerd door offertes.`);

  let updated = 0;
  let changes = 0;
  for (const { sku, inventoryItemId } of variants) {
    const free = freeBySku.get(sku);
    if (free === undefined) continue; // SKU niet in Odoo -> overslaan
    const available = Math.max(0, free - (reservations.get(sku) || 0));
    const current = levels.get(inventoryItemId);
    if (current === available) continue; // al gelijk

    changes++;
    if (config.service.dryRun) {
      log(`[odoo->shopify][DRY] ${sku}: ${current} -> ${available} (free ${free}, res ${reservations.get(sku) || 0}).`);
      continue;
    }
    try {
      await shopify.setAvailableByItem(inventoryItemId, available);
      updated++;
    } catch (err) {
      log(`[odoo->shopify] FOUT voor SKU ${sku}:`, err.message);
    }
  }
  log(`[odoo->shopify] ${changes} afwijking(en) gevonden, ${config.service.dryRun ? 0 : updated} weggeschreven.`);
}

async function main() {
  log(`Batch-sync start (dry-run: ${config.service.dryRun}).`);
  // Eerst verkopen in Odoo boeken, daarna de beschikbaarheid terug naar Shopify.
  await shopifyToOdoo();
  await odooToShopify();
  log('Batch-sync klaar.');
}

main().then(
  () => process.exit(0),
  (err) => {
    log('Batch-sync FATALE fout:', err.message);
    process.exit(1);
  }
);
