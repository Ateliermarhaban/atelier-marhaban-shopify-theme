import { authenticate, getStockLocationIds } from '../src/odoo.js';
import { shopifyFetch } from '../src/shopify.js';
import { config } from '../src/config.js';

async function main() {
  console.log('--- Odoo ---');
  const uid = await authenticate();
  console.log(`Verbonden met Odoo als uid ${uid} (db: ${config.odoo.db}).`);
  const locs = await getStockLocationIds();
  console.log(`Gevonden interne voorraadlocatie(s): ${locs.join(', ') || 'GEEN — controleer ODOO_LOCATION_NAME'}`);

  console.log('\n--- Shopify ---');
  const shop = await shopifyFetch('/shop.json');
  console.log(`Verbonden met shop: ${shop.shop.name} (${shop.shop.myshopify_domain}).`);
  const locations = await shopifyFetch('/locations.json');
  console.log('Beschikbare Shopify-locaties (gebruik het juiste id voor SHOPIFY_LOCATION_ID):');
  for (const l of locations.locations) {
    console.log(`  - ${l.id}  ${l.name}${l.active ? '' : ' (inactief)'}`);
  }
}

main().catch((err) => {
  console.error('Testfout:', err.message);
  process.exit(1);
});
