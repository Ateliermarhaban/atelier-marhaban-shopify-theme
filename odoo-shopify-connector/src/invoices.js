// Facturen voor POS-verkopen aan klanten met een btw-nummer.
//
// Per POS-bestelling met btw-nummer en zonder tag `factuur-odoo`:
//  1. PLAN (read-only, ook in dry-run): bedrijf op btw-nummer, adres, Peppol,
//     taks, producten, totaal, eerste-5-regel. Daaruit één logregel [factuur].
//  2. ACTIE (alleen live): concept-factuur, of boeken + betaling (MISC),
//     en verzending volgens het plan. Daarna tag factuur-odoo.
//
// Actie per bestelling:
//   "boeken + Peppol + mail"     BE-klant met Peppol-geverifieerd. Verzending via Peppol
//                                 (alleen als INVOICE_SEND_ENABLED=true).
//   "boeken + mail"              buitenlandse klant met e-mail. Geboekt; mail is
//                                 een concept voor Outlook (niet automatisch).
//   "boeken, niet versturen (PEPPOL-ONTBREEKT)"  BE-klant zonder Peppol.
//   "concept (reden)"            blijft in concept; reden staat in de log.
//
// Geen voorraadbeweging: die is al verwerkt door de voorraadsync.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

const INVOICE_TAG = 'factuur-odoo';
const SALES_JOURNAL_ID = 9; // Dagboek "Sales", code INV
const TAX_NAME = '21% incl.';
const FIRST_DRAFTS = 5;
// Bestellingen die bewust nooit gefactureerd worden (zoals #AM1009 in de voorraadsync).
const SKIP_ORDER_NAMES = new Set(['#AM1008']); // eigen testverkoop (TJM)
const SEND_ENABLED = String(process.env.INVOICE_SEND_ENABLED || '').toLowerCase() === 'true';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();
const round2 = (n) => Math.round(n * 100) / 100;

/** VIES-lookup (openbare EU-dienst). Alleen het btw-nummer wordt verstuurd. */
async function viesLookup(vat) {
  const clean = normVat(vat);
  try {
    const res = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${clean.slice(0, 2)}/vat/${clean.slice(2)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return { valid: false };
    const json = await res.json();
    const txt = (s) => (s && s.trim() !== '---' ? s.trim() : '');
    const lines = txt(json.address).split('\n').map((l) => l.trim()).filter(Boolean);
    const zipCity = (lines[lines.length - 1] || '').match(/^(\S+)\s+(.+)$/);
    return {
      valid: json.isValid === true,
      name: txt(json.name),
      street: lines.length > 1 ? lines[0] : '',
      zip: zipCity ? zipCity[1] : '',
      city: zipCity ? zipCity[2] : '',
    };
  } catch (err) {
    log(`[factuur] VIES-lookup mislukt voor ${clean}:`, err.message);
    return { valid: false };
  }
}

/** Betaalwijze uit de Shopify-gateway: cash of kaart. */
function paymentMethod(order) {
  const gateways = (order.payment_gateway_names || []).join(' ').toLowerCase();
  return /cash|kas|contant/.test(gateways) ? 'cash' : 'card';
}

/** Factuurregels (prijzen incl. btw, na korting). Read-only. */
async function buildLines(order, taxId) {
  const lines = [];
  const notes = [];
  for (const item of order.line_items || []) {
    const qty = Number(item.quantity) || 1;
    const unit = round2((Number(item.price) * qty - Number(item.total_discount || 0)) / qty);
    const productId = item.sku ? await odoo.findProductBySku(item.sku) : null;
    if (!productId) notes.push(`product ${item.sku || item.title} niet in Odoo`);
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

/**
 * Plan per bestelling. Leest alleen (geen aanmaak, geen boeking), zodat dit ook
 * in dry-run draait en dezelfde beslissing oplevert als de live run.
 */
async function planOrder(order, info, taxId) {
  const ba = order.billing_address || {};
  const companyName = info.company || ba.company
    || [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || info.email;
  const existingId = await odoo.findCompanyIdByVat(info.vat);
  const reasons = [];

  // Adres: bestaand bedrijf, dan Shopify-billing, dan VIES.
  let hasAddress = false;
  let vies = null;
  let peppolState = null;
  let companyCountry = '';
  if (existingId) {
    const f = await odoo.getCompanyFields(existingId);
    peppolState = f.peppol_verification_state || null;
    hasAddress = !!(f.street && f.zip && f.city);
    companyCountry = f.country_id ? await odoo.getCountryCodeById(f.country_id[0]) : '';
  }
  if (!hasAddress && ba.address1 && ba.zip && ba.city) hasAddress = true;
  if (!hasAddress) {
    vies = await viesLookup(info.vat);
    if (!vies.valid) reasons.push('ongeldig VIES-nummer');
    else if (!vies.street) reasons.push('VIES geeft geen adres');
    else hasAddress = true;
  }
  if (!hasAddress) reasons.push('geen adres');
  if (!taxId) reasons.push(`btw-taks "${TAX_NAME}" ontbreekt`);

  const { lines, notes } = taxId ? await buildLines(order, taxId) : { lines: [], notes: [] };
  reasons.push(...notes);

  const sum = lines.reduce((s, l) => s + l.price_unit * l.quantity, 0);
  const expected = Number(order.total_price);
  if (taxId && Math.abs(round2(sum) - expected) > 0.01) {
    reasons.push(`totaal ${round2(sum)} wijkt af van Shopify ${expected}`);
  }

  const n = await odoo.countConnectorInvoices();
  if (n < FIRST_DRAFTS) reasons.push(`eerste ${FIRST_DRAFTS} facturen blijven in concept (nr ${n + 1})`);

  // Peppol: alleen BE en geverifieerd. Buitenlands: geen Peppol.
  const isBE = (companyCountry || normVat(info.vat).slice(0, 2)) === 'BE';
  const peppol = isBE && peppolState === 'valid';
  const email = info.email || order.customer.email || '';

  let action;
  if (reasons.length) action = `concept (${reasons.join('; ')})`;
  else if (peppol) action = 'boeken + Peppol + mail';
  else if (isBE) action = 'boeken, niet versturen (PEPPOL-ONTBREEKT)';
  else action = 'boeken + mail';

  return {
    existingId, companyName, vat: normVat(info.vat), email, peppol, peppolState,
    method: paymentMethod(order), total: expected, action, reasons, lines, vies, isBE,
  };
}

function logPlan(order, info, plan) {
  const cust = `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim();
  log(
    `[factuur] ${order.name} | klant ${cust || '-'} | bedrijf ${plan.companyName} | btw ${plan.vat}` +
    ` | totaal ${plan.total.toFixed(2)} incl. btw | betaling ${plan.method}` +
    ` | partner ${plan.existingId ? plan.existingId : 'nieuw'}` +
    ` | Peppol ${plan.peppol ? 'ja' : 'nee'} (${plan.peppolState || 'onbekend'})` +
    ` | mail naar ${plan.email || '-'} | ${plan.action}`
  );
}

/** Live: uitvoeren van het plan. Alleen aangeroepen als niet dry-run. */
async function executePlan(order, info, plan) {
  const ref = `SHOP-${order.name.replace('#', '')}`;
  const date = (order.created_at || '').slice(0, 10);

  // Bedrijf: bestaand, of aanmaken op btw-nummer.
  const { id: companyId, created } = await odoo.findOrCreateCompanyByVat({ name: plan.companyName, vat: plan.vat });
  if (created) log(`[factuur] ${order.name}: bedrijf aangemaakt (${plan.vat}).`);
  // Contactpersoon.
  const personName = [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') || plan.email;
  if (plan.email) await odoo.findOrCreatePersonUnder(companyId, { name: personName, email: plan.email });

  // Adres aanvullen (overschrijft niets).
  const ba = order.billing_address || {};
  const vies = plan.vies;
  await odoo.fillCompanyAddress(companyId, {
    street: ba.address1 || (vies && vies.street) || '',
    zip: ba.zip || (vies && vies.zip) || '',
    city: ba.city || (vies && vies.city) || '',
    countryCode: ba.country_code || plan.vat.slice(0, 2),
  });

  const invoiceId = await odoo.createDraftInvoice({
    partnerId: companyId, journalId: SALES_JOURNAL_ID, ref, date, lines: plan.lines,
  });
  const inv = await odoo.readInvoice(invoiceId);
  if (Math.abs(inv.amount_total - plan.total) > 0.01) {
    log(`[factuur] ${order.name}: totaal Odoo ${inv.amount_total} <> Shopify ${plan.total}. Blijft concept.`);
    return;
  }
  if (plan.action.startsWith('concept')) {
    log(`[factuur] ${order.name}: concept aangemaakt (${inv.name || invoiceId}). ${plan.action}`);
    return;
  }

  // Boeken en betalen.
  await odoo.postInvoice(invoiceId);
  const payId = await odoo.createPaymentEntry({
    ref: `${ref}-betaling`, date, companyId, method: plan.method, amount: plan.total,
  });
  await odoo.postInvoice(payId);
  await odoo.reconcileWithInvoice(invoiceId, payId, companyId);
  log(`[factuur] ${order.name}: geboekt en betaald (${plan.method}).`);

  if (plan.action === 'boeken + Peppol + mail') {
    await odoo.setPeppolIfVerified(companyId);
    if (SEND_ENABLED) {
      await odoo.sendInvoice(invoiceId);
      log(`[factuur] ${order.name}: verzonden via Peppol.`);
    } else {
      log(`[factuur] ${order.name}: Peppol-verzending staat uit (INVOICE_SEND_ENABLED).`);
    }
  } else if (plan.action === 'boeken + mail') {
    log(`[factuur] ${order.name}: buitenlands. Niet automatisch gemaild, concept voor Outlook nodig (${plan.email}).`);
  }
}

export async function syncInvoices() {
  const taxId = await odoo.getTaxIdByName(TAX_NAME);
  const orders = await shopify.listPosOrdersNeedingInvoice({ sinceDays: 7, invoiceTag: INVOICE_TAG });
  const dry = config.service.dryRun;
  log(`[factuur] ${orders.length} POS-bestelling(en) zonder factuur${dry ? ' (dry-run)' : ''}.`);

  for (const order of orders) {
    if (SKIP_ORDER_NAMES.has(order.name)) {
      log(`[factuur] ${order.name} handmatig uitgesloten -> overslaan.`);
      continue;
    }
    if (!order.customer) continue; // anonieme POS-verkoop
    const info = await shopify.getCustomerVatInfo(order.customer.id);
    if (!info || !normVat(info.vat)) continue; // geen btw-nummer
    const infoN = { ...info, vat: normVat(info.vat) };

    try {
      const plan = await planOrder(order, infoN, taxId);
      logPlan(order, infoN, plan);
      if (dry) continue;
      await executePlan(order, infoN, plan);
      await shopify.tagOrderSynced(order, INVOICE_TAG);
    } catch (err) {
      log(`[factuur] FOUT ${order.name}:`, err.message);
    }
  }
}
