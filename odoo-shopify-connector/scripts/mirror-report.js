// Spiegelrapport Odoo <-> Shopify (alleen lezen, schrijft niets weg).
// Vergelijkt per SKU: bestaat het in beide systemen, klopt de prijs (Odoo excl. btw x 1,21)
// en klopt de voorraad (Odoo free_qty - offertereserveringen = Shopify available).
import { config } from '../src/config.js';
import * as odoo from '../src/odoo.js';
import { shopifyFetch } from '../src/shopify.js';
import * as shopify from '../src/shopify.js';

const r2 = (x) => Math.round(x * 100) / 100;

async function allShopifyVariants() {
  const out = [];
  let since = 0;
  while (true) {
    const data = await shopifyFetch(`/products.json?limit=250&since_id=${since}&fields=id,title,status,variants`);
    const products = data.products || [];
    for (const p of products) {
      for (const v of p.variants || []) {
        out.push({
          product: p.title, status: p.status, variant: v.title, sku: v.sku || '',
          price: Number(v.price), tracked: v.inventory_management === 'shopify',
          inventoryItemId: v.inventory_item_id,
        });
      }
    }
    if (products.length < 250) break;
    since = products[products.length - 1].id;
  }
  return out;
}

async function allOdooProducts() {
  const out = [];
  let offset = 0;
  const locationIds = await odoo.getStockLocationIds();
  const context = locationIds.length ? { location: locationIds[0] } : {};
  while (true) {
    const recs = await odoo.execute('product.product', 'search_read', [[['sale_ok', '=', true]]], {
      fields: ['default_code', 'display_name', 'lst_price', 'free_qty', 'is_storable', 'type'],
      limit: 1000, offset, context,
    });
    out.push(...recs);
    if (recs.length < 1000) break;
    offset += 1000;
  }
  return out;
}

function section(title, rows, max = 400) {
  console.log(`\n=== ${title}: ${rows.length} ===`);
  rows.slice(0, max).forEach((r) => console.log('  ' + r));
  if (rows.length > max) console.log(`  ... en nog ${rows.length - max}`);
}

async function main() {
  const [sv, ov, reservations] = await Promise.all([
    allShopifyVariants(), allOdooProducts(), odoo.getOpenQuotationReservations(),
  ]);
  const levels = await shopify.getAvailableLevelsBulk(sv.map((v) => v.inventoryItemId));

  const odooBySku = new Map();
  const odooNoSku = [];
  for (const o of ov) {
    if (o.default_code) odooBySku.set(o.default_code, o); else odooNoSku.push(o.display_name);
  }
  const shopBySku = new Map();
  const dupSku = [];
  const shopNoSku = [];
  for (const s of sv) {
    if (!s.sku) { shopNoSku.push(`${s.product} / ${s.variant} [${s.status}]`); continue; }
    if (shopBySku.has(s.sku)) dupSku.push(`${s.sku}: ${s.product} / ${s.variant}`);
    shopBySku.set(s.sku, s);
  }

  const notInOdoo = [], priceDiff = [], stockDiff = [], untracked = [];
  for (const s of sv) {
    if (!s.sku) continue;
    const o = odooBySku.get(s.sku);
    if (!o) { notInOdoo.push(`${s.sku}  ${s.product} / ${s.variant} [${s.status}]`); continue; }
    const incl = r2(o.lst_price * 1.21);
    if (Math.abs(incl - s.price) > 0.005) priceDiff.push(`${s.sku}  ${s.product} / ${s.variant}: Shopify ${s.price} <> Odoo ${incl}`);
    if (!s.tracked) { untracked.push(`${s.sku}  ${s.product} / ${s.variant} [${s.status}]`); continue; }
    const target = Math.max(0, Math.floor(o.free_qty || 0) - (reservations.get(s.sku) || 0));
    const cur = levels.get(s.inventoryItemId);
    if (cur !== target) stockDiff.push(`${s.sku}  ${s.product} / ${s.variant}: Shopify ${cur} <> Odoo ${target} (free ${o.free_qty})`);
  }
  const notInShopify = [];
  for (const [sku, o] of odooBySku) if (!shopBySku.has(sku)) notInShopify.push(`${sku}  ${o.display_name}  € ${r2(o.lst_price * 1.21)}  vrij ${o.free_qty}`);

  console.log(`Shopify: ${sv.length} varianten (${shopBySku.size} met SKU). Odoo: ${ov.length} verkoopbare varianten (${odooBySku.size} met SKU). Open offertes: ${reservations.size} SKU('s).`);
  section('Prijs verschilt', priceDiff);
  section('Voorraad verschilt', stockDiff);
  section('In Shopify, niet in Odoo', notInOdoo);
  section('In Odoo, niet in Shopify', notInShopify.sort());
  section('Shopify zonder SKU', shopNoSku);
  section('Odoo zonder SKU (verkoopbaar)', odooNoSku);
  section('Shopify: voorraad niet bijgehouden', untracked);
  section('Dubbele SKU in Shopify', dupSku);
}

main().then(() => process.exit(0), (err) => { console.error('FOUT:', err.message); process.exit(1); });
