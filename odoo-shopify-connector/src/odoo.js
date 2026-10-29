import xmlrpc from 'xmlrpc';
import { config } from './config.js';

// --- XML-RPC endpoints (stabiel op alle Odoo-edities, inclusief Online SaaS) ---
const commonClient = xmlrpc.createSecureClient(`${config.odoo.url}/xmlrpc/2/common`);
const objectClient = xmlrpc.createSecureClient(`${config.odoo.url}/xmlrpc/2/object`);

function call(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

let cachedUid = null;

export async function authenticate() {
  if (cachedUid) return cachedUid;
  const uid = await call(commonClient, 'authenticate', [
    config.odoo.db,
    config.odoo.username,
    config.odoo.apiKey,
    {},
  ]);
  if (!uid) {
    throw new Error('Odoo-authenticatie mislukt. Controleer ODOO_DB, ODOO_USERNAME en ODOO_API_KEY.');
  }
  cachedUid = uid;
  return uid;
}

export async function execute(model, method, args = [], kwargs = {}) {
  const uid = await authenticate();
  return call(objectClient, 'execute_kw', [
    config.odoo.db,
    uid,
    config.odoo.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

/**
 * Zoek het product.product (variant) record-id op basis van SKU (default_code).
 */
export async function findProductBySku(sku) {
  const ids = await execute('product.product', 'search', [[['default_code', '=', sku]]], { limit: 1 });
  return ids.length ? ids[0] : null;
}

/**
 * Haal de interne location-id op die bij ODOO_LOCATION_NAME hoort (of alle interne locaties).
 */
export async function getStockLocationIds() {
  const domain = [['usage', '=', 'internal']];
  if (config.odoo.locationName) {
    domain.push(['complete_name', '=', config.odoo.locationName]);
  }
  return execute('stock.location', 'search', [domain]);
}

/**
 * Totale on-hand (quantity) voor een SKU op de gekozen locatie(s).
 */
export async function getOnHandQty(sku) {
  const productId = await findProductBySku(sku);
  if (!productId) return null;
  const locationIds = await getStockLocationIds();
  if (!locationIds.length) return null;

  const quants = await execute('stock.quant', 'search_read', [
    [
      ['product_id', '=', productId],
      ['location_id', 'in', locationIds],
    ],
  ], { fields: ['quantity'] });

  const qty = quants.reduce((sum, q) => sum + (q.quantity || 0), 0);
  return Math.floor(qty);
}

/**
 * Vrij te gebruiken voorraad (free_qty = on-hand - reserveringen van bevestigde
 * orders) voor een SKU. Dit is de "Odoo is leidend"-basiswaarde.
 */
export async function getFreeQty(sku) {
  const productId = await findProductBySku(sku);
  if (productId === null) return null;
  const locationIds = await getStockLocationIds();
  const ctx = {};
  if (locationIds.length) {
    // free_qty wordt per locatie berekend wanneer 'location' in de context staat.
    ctx.location = locationIds[0];
  }
  const records = await execute('product.product', 'read', [[productId]], {
    fields: ['free_qty'],
    context: ctx,
  });
  if (!records.length) return null;
  return Math.floor(records[0].free_qty || 0);
}

/**
 * Bulk: free_qty voor ALLE producten met een SKU, in enkele paginated calls.
 * Veel sneller dan per SKU afzonderlijk opvragen. Geeft Map sku -> free_qty.
 */
export async function getAllFreeQtyBySku() {
  const locationIds = await getStockLocationIds();
  const context = locationIds.length ? { location: locationIds[0] } : {};
  const result = new Map();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const records = await execute('product.product', 'search_read', [
      [['default_code', '!=', false]],
    ], {
      fields: ['default_code', 'free_qty'],
      limit: pageSize,
      offset,
      context,
    });
    for (const rec of records) {
      if (rec.default_code) result.set(rec.default_code, Math.floor(rec.free_qty || 0));
    }
    if (records.length < pageSize) break;
    offset += pageSize;
  }
  return result;
}

/**
 * Hoeveelheden die gereserveerd zijn door OPEN, NIET-verlopen offertes.
 * Een offerte = sale.order in state 'draft' of 'sent'. Een offerte telt mee zolang
 * ze geen validity_date heeft of de validity_date vandaag of later valt; is de
 * datum verstreken, dan valt de reservering automatisch weg.
 * Geeft een Map terug: SKU -> totaal gereserveerd aantal.
 */
export async function getOpenQuotationReservations() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const domain = [
    ['order_id.state', 'in', ['draft', 'sent']],
    ['display_type', '=', false], // sla sectie-/notitieregels over
    '|',
    ['order_id.validity_date', '=', false],
    ['order_id.validity_date', '>=', today],
  ];
  const lines = await execute('sale.order.line', 'search_read', [domain], {
    fields: ['product_id', 'product_uom_qty'],
  });
  if (!lines.length) return new Map();

  const productIds = [...new Set(lines.map((l) => l.product_id && l.product_id[0]).filter(Boolean))];
  const products = await execute('product.product', 'read', [productIds], {
    fields: ['default_code'],
  });
  const skuById = new Map(products.map((p) => [p.id, p.default_code]));

  const reserved = new Map();
  for (const line of lines) {
    const productId = line.product_id && line.product_id[0];
    const sku = skuById.get(productId);
    if (!sku) continue; // geen SKU => niet syncbaar
    reserved.set(sku, (reserved.get(sku) || 0) + (line.product_uom_qty || 0));
  }
  return reserved;
}

/**
 * Zet de absolute on-hand hoeveelheid voor een SKU in Odoo via een
 * voorraadtelling (stock.quant inventory_quantity + action_apply_inventory).
 */
export async function setOnHandQty(sku, newQty) {
  const productId = await findProductBySku(sku);
  if (!productId) {
    throw new Error(`Geen Odoo-product gevonden voor SKU "${sku}".`);
  }
  const locationIds = await getStockLocationIds();
  if (!locationIds.length) {
    throw new Error('Geen interne Odoo-voorraadlocatie gevonden.');
  }
  // Boek op de eerste (primaire) locatie.
  const locationId = locationIds[0];

  // Bestaande quant zoeken of aanmaken.
  const quantIds = await execute('stock.quant', 'search', [
    [
      ['product_id', '=', productId],
      ['location_id', '=', locationId],
    ],
  ], { limit: 1 });

  let quantId;
  if (quantIds.length) {
    quantId = quantIds[0];
    await execute('stock.quant', 'write', [[quantId], { inventory_quantity: newQty }]);
  } else {
    quantId = await execute('stock.quant', 'create', [{
      product_id: productId,
      location_id: locationId,
      inventory_quantity: newQty,
    }]);
  }

  // Telling toepassen zodat de on-hand echt wijzigt.
  await execute('stock.quant', 'action_apply_inventory', [[quantId]]);
  return newQty;
}

/**
 * Pas de on-hand aan met een relatief verschil (bv. -2 bij een verkoop).
 */
export async function adjustOnHandQty(sku, delta) {
  const current = await getOnHandQty(sku);
  if (current === null) {
    throw new Error(`Kan voorraad voor SKU "${sku}" niet lezen in Odoo.`);
  }
  const target = Math.max(0, current + delta);
  await setOnHandQty(sku, target);
  return target;
}

/**
 * Lees alle quants die sinds een bepaald tijdstip gewijzigd zijn (voor polling).
 * Geeft een lijst { sku, qty } terug, geaggregeerd per product over de locaties.
 */
export async function getChangedStockSince(isoDatetime) {
  const locationIds = await getStockLocationIds();
  if (!locationIds.length) return [];

  const domain = [['location_id', 'in', locationIds]];
  if (isoDatetime) {
    domain.push(['write_date', '>', isoDatetime]);
  }

  const changed = await execute('stock.quant', 'search_read', [domain], {
    fields: ['product_id', 'write_date'],
  });
  if (!changed.length) return [];

  // Unieke product-id's verzamelen, dan totalen per product berekenen.
  const productIds = [...new Set(changed.map((q) => q.product_id[0]))];

  const products = await execute('product.product', 'read', [productIds], {
    fields: ['default_code'],
  });
  const skuById = new Map(products.map((p) => [p.id, p.default_code]));

  const results = [];
  for (const productId of productIds) {
    const sku = skuById.get(productId);
    if (!sku) continue; // geen SKU => niet syncbaar
    const quants = await execute('stock.quant', 'search_read', [
      [
        ['product_id', '=', productId],
        ['location_id', 'in', locationIds],
      ],
    ], { fields: ['quantity'] });
    const qty = Math.floor(quants.reduce((s, q) => s + (q.quantity || 0), 0));
    results.push({ sku, qty });
  }
  return results;
}
