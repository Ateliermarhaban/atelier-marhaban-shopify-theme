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
import { syncCustomers } from './customers.js';
import { syncInvoices } from './invoices.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const SYNCED_TAG = 'odoo-synced';

// Orders die handmatig worden afgehandeld en NOOIT automatisch geboekt mogen
// worden (anders dubbel afgeboekt). Match op order-naam, bv. '#AM1009'.
// #AM1009 (8/11, SKU 105708-125-OB) staat niet in Odoo; die SKU wordt met de
// hand op 0 gezet in beide systemen.
const SKIP_ORDER_NAMES = new Set(['#AM1009', 'AM1009']);

/** Richting 1: Shopify-verkopen (web/POS) verwerken in Odoo. */
async function shopifyToOdoo() {
  const orders = await shopify.listUnsyncedOrders({ sinceDays: 7, syncedTag: SYNCED_TAG });
  log(`[shopify->odoo] ${orders.length} nieuwe order(s) te verwerken.`);

  for (const order of orders) {
    const orderName = (order.name || '').trim();
    if (SKIP_ORDER_NAMES.has(orderName)) {
      log(`[shopify->odoo] Order ${orderName} handmatig uitgesloten -> overslaan (niet boeken).`);
      // In live modus labelen zodat hij definitief uit de wachtrij valt.
      if (!config.service.dryRun) {
        await shopify.tagOrderSynced(order, SYNCED_TAG);
      }
      continue;
    }
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
    // Verschil-log per SKU (altijd, ook live): Shopify had X, Odoo wil Y.
    log(`[verschil] ${sku}: Shopify ${current} <-> Odoo ${available} (free ${free}, offerte-res ${reservations.get(sku) || 0}).`);
    if (config.service.dryRun) {
      log(`[odoo->shopify][DRY] ${sku}: ${current} -> ${available} (niet weggeschreven).`);
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
  // Klant-/adressynchronisatie (beide richtingen, alleen nieuwe).
  if (config.service.syncCustomers) {
    try {
      await syncCustomers();
    } catch (err) {
      log('[klanten] FOUT:', err.message);
    }
  }
  // POS-facturen voor klanten met btw-nummer. Standaard UIT: zet SYNC_INVOICES=true
  // (repo-variabele) pas na een geslaagde DRY-run.
  if (String(process.env.SYNC_INVOICES || '').toLowerCase() === 'true') {
    try {
      await syncInvoices();
    } catch (err) {
      log('[factuur] FOUT:', err.message);
    }
  }
  log('Batch-sync klaar.');
}

main().then(
  () => process.exit(0),
  (err) => {
    log('Batch-sync FATALE fout:', err.message);
    process.exit(1);
  }
);
