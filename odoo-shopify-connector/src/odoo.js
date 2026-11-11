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
  const ids = await execute('stock.location', 'search', [domain]);
  // Fail-fast: een verkeerde locatienaam mag NIET stilletjes leiden tot
  // verkeerde voorraadcijfers (lege lijst -> alle locaties of null-waardes).
  if (config.odoo.locationName && ids.length === 0) {
    throw new Error(
      `Odoo-locatie "${config.odoo.locationName}" bestaat niet (complete_name). Controleer ODOO_LOCATION_NAME; sync gestopt.`
    );
  }
  return ids;
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

// --- Klanten / adressen (res.partner) ---

// Landen één keer inladen: code <-> id in beide richtingen.
let countryCache = null;
async function loadCountries() {
  if (countryCache) return countryCache;
  const records = await execute('res.country', 'search_read', [[]], { fields: ['code'] });
  const byCode = new Map();
  const byId = new Map();
  for (const c of records) {
    if (c.code) {
      byCode.set(c.code.toUpperCase(), c.id);
      byId.set(c.id, c.code.toUpperCase());
    }
  }
  countryCache = { byCode, byId };
  return countryCache;
}

export async function getCountryIdByCode(code) {
  if (!code) return null;
  const { byCode } = await loadCountries();
  return byCode.get(String(code).toUpperCase()) || null;
}

export async function getCountryCodeById(id) {
  if (!id) return null;
  const { byId } = await loadCountries();
  return byId.get(id) || null;
}

/**
 * Alle e-mailadressen die al op een res.partner staan (ongeacht type), als lowercase Set.
 * Dient als dedup-doel voor Shopify -> Odoo: we maken geen partner aan die al bestaat.
 */
export async function getAllPartnerEmails() {
  const emails = new Set();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const records = await execute('res.partner', 'search_read', [
      [['email', '!=', false]],
    ], { fields: ['email'], limit: pageSize, offset });
    for (const r of records) {
      if (r.email) emails.add(r.email.trim().toLowerCase());
    }
    if (records.length < pageSize) break;
    offset += pageSize;
  }
  return emails;
}

/**
 * Synchroniseerbare partners: alle contacten met e-mail die GEEN leverancier zijn
 * (supplier_rank = 0), ook als customer_rank 0 is. Interne sub-adressen
 * (type != 'contact') en backend-/portaalgebruikers (user_ids gevuld) worden
 * overgeslagen. Bron voor Odoo -> Shopify en voor het aanvullen van velden.
 */
export async function listSyncablePartners() {
  const results = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const records = await execute('res.partner', 'search_read', [
      [
        ['email', '!=', false],
        ['supplier_rank', '=', 0],
        ['type', '=', 'contact'],
        ['user_ids', '=', false],
      ],
    ], {
      fields: [
        'name', 'email', 'phone', 'street', 'street2', 'city', 'zip',
        'country_id', 'vat', 'customer_rank', 'parent_id', 'is_company',
      ],
      limit: pageSize,
      offset,
    });
    results.push(...records);
    if (records.length < pageSize) break;
    offset += pageSize;
  }

  // Odoo 20 kent geen company_name op personen. Bedrijfsnaam = naam van het
  // gekoppelde bedrijf (parent_id, is_company). Btw = vat van het bedrijf,
  // met het eigen vat van de persoon als fallback.
  const parentIds = [...new Set(results.map((r) => r.parent_id && r.parent_id[0]).filter(Boolean))];
  const parents = new Map();
  for (let i = 0; i < parentIds.length; i += 1000) {
    const chunk = parentIds.slice(i, i + 1000);
    const recs = await execute('res.partner', 'read', [chunk], { fields: ['name', 'vat', 'is_company'] });
    for (const r of recs) parents.set(r.id, r);
  }
  for (const r of results) {
    const parent = r.parent_id ? parents.get(r.parent_id[0]) : null;
    r.parentId = parent ? parent.id : null;
    r.company_name = parent && parent.is_company ? parent.name : '';
    r.vat = (parent && parent.vat) || r.vat || '';
  }
  return results;
}

/** Normaliseer btw-nummer voor vergelijking (spaties/punten weg, hoofdletters). */
const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();

/**
 * Zoek een bestaand bedrijf (is_company) op btw-nummer, anders op exacte naam.
 * Bestaat het niet, dan wordt het aangemaakt met naam en btw. Geeft het id terug.
 */
export async function findOrCreateCompany({ name, vat }) {
  const cleanVat = normVat(vat);
  if (cleanVat) {
    const byVat = await execute('res.partner', 'search_read', [
      [['is_company', '=', true], ['vat', '!=', false]],
    ], { fields: ['vat'], limit: 0 });
    const hit = byVat.find((r) => normVat(r.vat) === cleanVat);
    if (hit) return hit.id;
  }
  if (name) {
    const byName = await execute('res.partner', 'search', [
      [['is_company', '=', true], ['name', '=', name]],
    ], { limit: 1 });
    if (byName.length) return byName[0];
  }
  return execute('res.partner', 'create', [{
    name: name || cleanVat,
    is_company: true,
    ...(vat ? { vat: String(vat).trim() } : {}),
  }]);
}

/**
 * Koppel een persoon aan een bedrijf via parent_id. Schrijft alleen als er nog
 * géén parent_id staat: een bestaande koppeling wordt nooit overschreven.
 */
export async function linkPartnerToCompany(partnerId, { name, vat }) {
  const [partner] = await execute('res.partner', 'read', [[partnerId]], { fields: ['parent_id'] });
  if (partner && partner.parent_id) return false;
  const companyId = await findOrCreateCompany({ name, vat });
  await execute('res.partner', 'write', [[partnerId], { parent_id: companyId }]);
  return true;
}

/**
 * Werk losse velden bij op een bestaande partner. Schrijft alleen de meegegeven
 * sleutels (countryCode wordt vertaald naar country_id). Lege values worden
 * genegeerd zodat niets per ongeluk gewist wordt.
 */
export async function updatePartnerFields(id, { phone, street, street2, city, zip, countryCode } = {}) {
  const values = {};
  if (phone) values.phone = phone;
  if (street) values.street = street;
  if (street2) values.street2 = street2;
  if (city) values.city = city;
  if (zip) values.zip = zip;
  if (countryCode) {
    const countryId = await getCountryIdByCode(countryCode);
    if (countryId) values.country_id = countryId;
  }
  if (Object.keys(values).length === 0) return false;
  await execute('res.partner', 'write', [[id], values]);
  return true;
}

/**
 * Maak een nieuwe klant-partner aan in Odoo (customer_rank = 1).
 */
export async function createCustomerPartner({ name, email, phone, street, street2, city, zip, countryCode, company_name, vat }) {
  const values = {
    name: name || email,
    email,
    customer_rank: 1,
  };
  if (phone) values.phone = phone;
  if (street) values.street = street;
  if (street2) values.street2 = street2;
  if (city) values.city = city;
  if (zip) values.zip = zip;
  const countryId = await getCountryIdByCode(countryCode);
  if (countryId) values.country_id = countryId;
  // Bedrijf via parent_id (btw hoort bij het bedrijf, niet bij de persoon).
  if (company_name || vat) {
    values.parent_id = await findOrCreateCompany({ name: company_name, vat });
  }
  return execute('res.partner', 'create', [values]);
}

// --- Facturatie (POS-verkopen met btw-nummer) ---

/**
 * Zoek een bedrijf UITSLUITEND op btw-nummer (vat), nooit op naam, zodat er geen
 * duplicaten ontstaan zoals "BE0460915888, Gryp Vloeren". Bestaat het niet, dan
 * wordt het aangemaakt.
 */
export async function findOrCreateCompanyByVat({ name, vat }) {
  const clean = normVat(vat);
  if (!clean) throw new Error('Geen btw-nummer opgegeven.');
  const companies = await execute('res.partner', 'search_read', [
    [['is_company', '=', true], ['vat', '!=', false]],
  ], { fields: ['vat', 'name'], limit: 0 });
  const hit = companies.find((r) => normVat(r.vat) === clean);
  if (hit) return { id: hit.id, created: false };
  const id = await execute('res.partner', 'create', [{
    name: name || clean,
    vat: String(vat).trim(),
    is_company: true,
  }]);
  return { id, created: true };
}

/** Contactpersoon onder een bedrijf, op e-mail. Maakt aan als die ontbreekt. */
export async function findOrCreatePersonUnder(companyId, { name, email }) {
  const found = await execute('res.partner', 'search', [
    [['parent_id', '=', companyId], ['email', '=ilike', email]],
  ], { limit: 1 });
  if (found.length) return found[0];
  return execute('res.partner', 'create', [{
    name: name || email,
    email,
    parent_id: companyId,
    type: 'contact',
  }]);
}

export async function getCompanyFields(companyId) {
  const [rec] = await execute('res.partner', 'read', [[companyId]], {
    fields: ['street', 'street2', 'city', 'zip', 'country_id', 'peppol_verification_state', 'invoice_sending_method', 'invoice_edi_format'],
  });
  return rec;
}

/** Vul ontbrekende adresvelden van een bedrijf aan (overschrijft niets). */
export async function fillCompanyAddress(companyId, { street, zip, city, countryCode }) {
  const current = await getCompanyFields(companyId);
  const values = {};
  if (!current.street && street) values.street = street;
  if (!current.zip && zip) values.zip = zip;
  if (!current.city && city) values.city = city;
  if (!current.country_id && countryCode) {
    const cid = await getCountryIdByCode(countryCode);
    if (cid) values.country_id = cid;
  }
  if (Object.keys(values).length) await execute('res.partner', 'write', [[companyId], values]);
  return Object.keys(values);
}

/** Zet Peppol-verzending op een bedrijf, alleen als het Peppol-geverifieerd is. */
export async function setPeppolIfVerified(companyId) {
  const c = await getCompanyFields(companyId);
  if (c.peppol_verification_state !== 'valid') return false;
  await execute('res.partner', 'write', [[companyId], {
    invoice_sending_method: 'peppol',
    invoice_edi_format: 'ubl_bis3',
  }]);
  return true;
}

export async function getTaxIdByName(name) {
  const ids = await execute('account.tax', 'search', [[['name', '=', name], ['type_tax_use', '=', 'sale']]], { limit: 1 });
  return ids.length ? ids[0] : null;
}

export async function getAccountIdByCode(code) {
  const ids = await execute('account.account', 'search', [[['code', '=', code]]], { limit: 1 });
  return ids.length ? ids[0] : null;
}

/** Concept-klantfactuur (out_invoice) met regels. Geen voorraadbeweging. */
export async function createDraftInvoice({ partnerId, journalId, ref, date, lines }) {
  return execute('account.move', 'create', [{
    move_type: 'out_invoice',
    partner_id: partnerId,
    journal_id: journalId,
    ref,
    invoice_date: date,
    invoice_line_ids: lines.map((l) => [0, 0, l]),
  }]);
}

export async function readInvoice(id) {
  const [rec] = await execute('account.move', 'read', [[id]], {
    fields: ['amount_total', 'state', 'name', 'partner_id'],
  });
  return rec;
}

export async function postInvoice(id) {
  return execute('account.move', 'action_post', [[id]]);
}

/** Aantal connector-facturen (ref begint met SHOP-), om de eerste 5 in concept te houden. */
export async function countConnectorInvoices() {
  return execute('account.move', 'search_count', [[
    ['move_type', '=', 'out_invoice'],
    ['ref', '=like', 'SHOP-%'],
  ]]);
}

/**
 * Betaling als MISC-boeking, zoals de maandboeking: cash debet 570000, kaart
 * debet 400000 op de Shopify-partner; beide credit 400000 op het bedrijf.
 */
export async function createPaymentEntry({ ref, date, companyId, method, amount }) {
  const receivable = await getAccountIdByCode('400000');
  if (!receivable) throw new Error('Rekening 400000 niet gevonden.');
  const debitLine = method === 'cash'
    ? { account_id: await getAccountIdByCode('570000'), partner_id: false }
    : { account_id: receivable, partner_id: 40 /* Shopify */ };
  if (!debitLine.account_id) throw new Error('Rekening 570000 niet gevonden.');
  return execute('account.move', 'create', [{
    move_type: 'entry',
    journal_id: 11, // Miscellaneous Operations (MISC)
    date,
    ref,
    line_ids: [
      [0, 0, { ...debitLine, debit: amount, credit: 0, name: ref }],
      [0, 0, { account_id: receivable, partner_id: companyId, debit: 0, credit: amount, name: ref }],
    ],
  }]);
}

/** Afpunten: factuur-debet op het bedrijf tegen de betaal-credit op het bedrijf. */
export async function reconcileWithInvoice(invoiceId, paymentId, companyId) {
  const receivable = await getAccountIdByCode('400000');
  const invLines = await execute('account.move.line', 'search', [[
    ['move_id', '=', invoiceId], ['account_id', '=', receivable], ['partner_id', '=', companyId],
  ]], { limit: 1 });
  const payLines = await execute('account.move.line', 'search', [[
    ['move_id', '=', paymentId], ['account_id', '=', receivable], ['partner_id', '=', companyId],
  ]], { limit: 1 });
  if (!invLines.length || !payLines.length) throw new Error('Regels om af te punten niet gevonden.');
  await execute('account.move.line', 'reconcile', [[...invLines, ...payLines]]);
  return true;
}

/**
 * Verstuur een geboekte factuur (Peppol voor BE). NIET GETEST tegen Odoo 20:
 * wordt alleen aangeroepen als INVOICE_SEND_ENABLED=true.
 */
export async function sendInvoice(invoiceId) {
  return execute('account.move', 'action_send_and_print', [[invoiceId]]);
}

/** Read-only: id van een bestaand bedrijf op btw-nummer, of null. Maakt niets aan. */
export async function findCompanyIdByVat(vat) {
  const clean = normVat(vat);
  if (!clean) return null;
  const companies = await execute('res.partner', 'search_read', [
    [['is_company', '=', true], ['vat', '!=', false]],
  ], { fields: ['vat'], limit: 0 });
  const hit = companies.find((r) => normVat(r.vat) === clean);
  return hit ? hit.id : null;
}
