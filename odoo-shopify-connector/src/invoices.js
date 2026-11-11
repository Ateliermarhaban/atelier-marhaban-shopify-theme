// Facturen voor POS-verkopen aan klanten met een btw-nummer.
//
// Per Shopify-POS-bestelling waarvan de klant een btw-nummer heeft en die nog
// de tag `factuur-odoo` mist:
//  - bedrijf zoeken op btw-nummer (nooit op naam) of aanmaken; persoon als contact
//  - adres aanvullen uit Shopify, of via VIES (openbare EU-dienst) als het ontbreekt
//  - klantfactuur op dagboek Sales (INV, id 9), regels en eenheidsprijzen
//    uit de bestelling, btw "21% incl." (prijzen zijn incl. btw), referentie SHOP-<nr>
//  - GEEN voorraadbeweging: die is al verwerkt door de voorraadsync
//  - de eerste 5 facturen blijven in concept; daarna boeken + betaling
//  - betaling als MISC-boeking, afgepunt tegen de factuur
//  - verzending via Peppol alleen voor Belgische klanten die Peppol-geverifieerd zijn,
//    en alleen als INVOICE_SEND_ENABLED=true (standaard uit)
//  - concept blijft staan en wordt gelogd bij: geen adres, ongeldig VIES, afwijkend
//    totaal, ontbrekende btw-taks of product
//  - daarna krijgt de bestelling de tag factuur-odoo

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

const INVOICE_TAG = 'factuur-odoo';
const SALES_JOURNAL_ID = 9; // Dagboek "Sales", code INV
const TAX_NAME = '21% incl.';
const FIRST_DRAFTS = 5;
const SEND_ENABLED = String(process.env.INVOICE_SEND_ENABLED || '').toLowerCase() === 'true';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();
const round2 = (n) => Math.round(n * 100) / 100;

/** VIES-lookup. Geeft { valid, name, street, zip, city } terug, of { valid:false }. */
async function viesLookup(vat) {
  const clean = normVat(vat);
  const cc = clean.slice(0, 2);
  const num = clean.slice(2);
  try {
    const res = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${num}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return { valid: false };
    const json = await res.json();
    const clean2 = (s) => (s && s.trim() !== '---' ? s.trim() : '');
    const lines = clean2(json.address).split('\n').map((l) => l.trim()).filter(Boolean);
    const street = lines[0] || '';
    const zipCity = (lines[lines.length - 1] || '').match(/^(\S+)\s+(.+)$/);
    return {
      valid: json.isValid === true,
      name: clean2(json.name),
      street: lines.length > 1 ? street : '',
      zip: zipCity ? zipCity[1] : '',
      city: zipCity ? zipCity[2] : '',
    };
  } catch (err) {
    log(`[factuur] VIES-lookup mislukt voor ${clean}:`, err.message);
    return { valid: false };
  }
}

/** Betaalmethode uit de Shopify-gateway: cash of kaart. */
function paymentMethod(order) {
  const gateways = (order.payment_gateway_names || []).join(' ').toLowerCase();
  return /cash|kas|contant/.test(gateways) ? 'cash' : 'card';
}

/** Factuurregels uit de bestelling (prijzen incl. btw, na korting). */
async function buildLines(order, taxId) {
  const lines = [];
  const notes = [];
  for (const item of order.line_items || []) {
    const qty = Number(item.quantity) || 1;
    const unit = round2((Number(item.price) * qty - Number(item.total_discount || 0)) / qty);
    const productId = item.sku ? await odoo.findProductBySku(item.sku) : null;
    if (!productId) notes.push(`product ${item.sku || item.title} niet gevonden in Odoo`);
    lines.push({
      name: item.title,
      quantity: qty,
      price_unit: unit,
      tax_ids: [[6, 0, [taxId]]],
      ...(productId ? { product_id: productId } : {}),
    });
  }
  const shipping = (order.shipping_lines || []).reduce((s, l) => s + Number(l.price || 0), 0);
  if (shipping > 0) {
    lines.push({ name: 'Verzending', quantity: 1, price_unit: round2(shipping), tax_ids: [[6, 0, [taxId]]] });
  }
  return { lines, notes };
}

async function invoiceOrder(order, info) {
  const orderNr = order.name.replace('#', '');
  const ref = `SHOP-${orderNr}`;
  const concept = []; // redenen om in concept te laten

  // 1. Bedrijf op btw-nummer (nooit op naam).
  const billing = order.billing_address || {};
  const companyName = info.company || billing.company
    || [billing.first_name, billing.last_name].filter(Boolean).join(' ') || info.email;
  const { id: companyId, created } = await odoo.findOrCreateCompanyByVat({ name: companyName, vat: info.vat });
  if (created) log(`[factuur] Bedrijf aangemaakt voor ${info.vat} (${companyName}).`);

  // 2. Contactpersoon onder het bedrijf.
  const personName = [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || info.email;
  if (info.email) await odoo.findOrCreatePersonUnder(companyId, { name: personName, email: info.email });

  // 3. Adres: Shopify-billing eerst, dan VIES. Niets overschrijven.
  let street = billing.address1 || '';
  let zip = billing.zip || '';
  let city = billing.city || '';
  let country = billing.country_code || '';
  const current = await odoo.getCompanyFields(companyId);
  if (!current.street && !street) {
    const v = await viesLookup(info.vat);
    if (!v.valid) concept.push('ongeldig VIES-nummer');
    else {
      street = v.street; zip = v.zip; city = v.city;
      if (!street) concept.push('VIES geeft geen adres (bv. DE/ES), en Shopify heeft geen adres');
    }
    if (!country) country = normVat(info.vat).slice(0, 2);
  }
  await odoo.fillCompanyAddress(companyId, { street, zip, city, countryCode: country });
  const after = await odoo.getCompanyFields(companyId);
  if (!after.street || !after.zip || !after.city) concept.push('adres onvolledig');

  // 4. Btw-taks en regels.
  const taxId = await odoo.getTaxIdByName(TAX_NAME);
  if (!taxId) {
    log(`[factuur] ${ref}: btw-taks "${TAX_NAME}" ontbreekt in Odoo. Overgeslagen, niet getagd.`);
    return;
  }
  const { lines, notes } = await buildLines(order, taxId);
  concept.push(...notes);

  // 5. Concept-factuur. Geen voorraadbeweging.
  const date = (order.created_at || '').slice(0, 10);
  const invoiceId = await odoo.createDraftInvoice({
    partnerId: companyId, journalId: SALES_JOURNAL_ID, ref, date, lines,
  });
  const inv = await odoo.readInvoice(invoiceId);
  const expected = Number(order.total_price);
  if (Math.abs(inv.amount_total - expected) > 0.01) {
    concept.push(`totaal ${inv.amount_total} wijkt af van Shopify ${expected}`);
  }

  // 6. Eerste 5 blijven in concept; daarna boeken en betalen.
  const n = await odoo.countConnectorInvoices();
  if (n <= FIRST_DRAFTS) concept.push(`eerste ${FIRST_DRAFTS} facturen blijven in concept (nr ${n})`);

  if (concept.length) {
    log(`[factuur] ${ref}: CONCEPT (${inv.name || invoiceId}). Reden: ${concept.join('; ')}.`);
  } else {
    await odoo.postInvoice(invoiceId);
    const method = paymentMethod(order);
    const payId = await odoo.createPaymentEntry({
      ref: `${ref}-betaling`, date, companyId, method, amount: expected,
    });
    await odoo.postInvoice(payId); // action_post werkt ook voor MISC-boekingen
    await odoo.reconcileWithInvoice(invoiceId, payId, companyId);
    log(`[factuur] ${ref}: geboekt en betaald (${method}).`);

    // Verzending: Peppol alleen voor Belgische, Peppol-geverifieerde klanten.
    const isBE = (after.country_id ? await odoo.getCountryCodeById(after.country_id[0]) : '') === 'BE';
    const peppol = isBE && await odoo.setPeppolIfVerified(companyId);
    if (!peppol) {
      log(`[factuur] ${ref}: niet via Peppol (buitenlands of niet geverifieerd). NIET gemaild; concept voor Outlook nodig.`);
    } else if (SEND_ENABLED) {
      await odoo.sendInvoice(invoiceId);
      log(`[factuur] ${ref}: verzonden via Peppol.`);
    } else {
      log(`[factuur] ${ref}: Peppol-verzending staat uit (INVOICE_SEND_ENABLED).`);
    }
  }

  // 7. Tag, zodat de bestelling niet opnieuw wordt verwerkt.
  await shopify.tagOrderSynced(order, INVOICE_TAG);
}

export async function syncInvoices() {
  const orders = await shopify.listPosOrdersNeedingInvoice({ sinceDays: 7, invoiceTag: INVOICE_TAG });
  log(`[factuur] ${orders.length} POS-bestelling(en) zonder factuur.`);
  for (const order of orders) {
    const ref = order.name;
    if (!order.customer) continue; // anonieme POS-verkoop: geen factuur
    const info = await shopify.getCustomerVatInfo(order.customer.id);
    if (!info || !normVat(info.vat)) continue; // geen btw-nummer: niet hier

    if (config.service.dryRun) {
      log(`[factuur][DRY] ${ref}: factuur voor ${info.vat} (${info.company || info.email}), ${order.line_items.length} regel(s), ${order.total_price}.`);
      continue;
    }
    try {
      await invoiceOrder(order, { ...info, vat: normVat(info.vat) });
    } catch (err) {
      log(`[factuur] FOUT ${ref}:`, err.message);
    }
  }
}
