// Facturen voor POS-verkopen aan klanten met een btw- of ondernemingsnummer.
//
// Per POS-bestelling met een nummer in custom.btw_nummer en zonder tag `factuur-odoo`:
//  1. PLAN (read-only, ook in dry-run): welk nummer, bedrijf, adres, Peppol, taks,
//     producten, totaal, eerste-5-regel. Daaruit één logregel [factuur].
//  2. ACTIE (alleen live): concept-factuur, of boeken + betaling (MISC), en
//     verzending volgens het plan. Daarna tag factuur-odoo.
//
// Welk nummer:
//   - geldig in VIES (BE + 10 cijfers)      -> btw-nummer in vat, Peppol-check
//   - niet in VIES, wel geldig ondernemingsnr (10 cijfers, mod 97) -> bedrijf op
//     company_registry, vat leeg, geen Peppol (vrijgesteld, art. 44)
//   - geen van beide                        -> concept, reden in log
//
// Actie per bestelling:
//   "boeken + Peppol + mail"            BE-btw-nummer, op Peppol: via Peppol + mail met PDF.
//   "boeken + mail"                     buitenlands of niet op Peppol: mail met PDF.
//   "boeken + mail (geen btw-nummer)"   ondernemingsnummer, enkel mail met PDF.
//   "boeken, niet versturen (PEPPOL-ONTBREEKT)"  BE-btw-nummer zonder Peppol.
//   "concept (reden)"                   blijft in concept.
// Verzending gebeurt alleen als INVOICE_SEND_ENABLED=true.
// Geen voorraadbeweging: die is al verwerkt door de voorraadsync.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';
import { parseBeNumber, extractVatFromText } from './vat.js';

const INVOICE_TAG = 'factuur-odoo';
const SALES_JOURNAL_ID = 9; // Dagboek "Sales", code INV
const TAX_NAME = '21% incl.';
const FIRST_DRAFTS = 5;
// Bestellingen die bewust nooit gefactureerd worden (zoals #AM1009 in de voorraadsync).
const SKIP_ORDER_NAMES = new Set(['#AM1008']); // eigen testverkoop (TJM)
const OWN_VAT_DIGITS = '0562882189'; // TJM BV zelf: nooit aan onszelf factureren
const ERROR_TAG = 'factuur-fout';
const SEND_ENABLED = String(process.env.INVOICE_SEND_ENABLED || '').toLowerCase() === 'true';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();
const round2 = (n) => Math.round(n * 100) / 100;

/** VIES-lookup (openbare EU-dienst). Alleen het nummer wordt verstuurd. */
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
 * Plan per bestelling. Leest alleen (geen aanmaak, geen boeking), zodat dry-run
 * dezelfde beslissing oplevert als de live run.
 */
async function planOrder(order, info, taxId) {
  const ba = order.billing_address || {};
  const reasons = [];

  // 1. Welk nummer?
  const be = parseBeNumber(info.vat);
  let kind = null;      // 'vat' | 'registry'
  let vatValue = '';    // btw-nummer voor het vat-veld
  let digits = null;    // ondernemingsnummer
  let vies = null;
  if (be) {
    vies = await viesLookup(`BE${be}`);
    if (vies.valid) { kind = 'vat'; vatValue = `BE${be}`; }
    else { kind = 'registry'; digits = be; }
  } else {
    vies = await viesLookup(info.vat);
    if (vies.valid) { kind = 'vat'; vatValue = normVat(info.vat); }
    else reasons.push('geen geldig btw- of ondernemingsnummer');
  }

  const companyName = info.company || (vies && vies.name) || (order.source_name === 'pos' ? ba.company : '')
    || [ba.first_name, ba.last_name].filter(Boolean).join(' ')
    || [order.customer && order.customer.first_name, order.customer && order.customer.last_name].filter(Boolean).join(' ') || info.email;

  // 2. Bestaand bedrijf en adres.
  const existingId = kind === 'vat'
    ? await odoo.findCompanyIdByVat(vatValue)
    : kind === 'registry' ? await odoo.findCompanyIdByRegistry(digits) : null;
  let peppolState = null;
  let companyCountry = '';
  let hasAddress = false;
  if (existingId) {
    const f = await odoo.getCompanyFields(existingId);
    peppolState = f.peppol_verification_state || null;
    hasAddress = !!(f.street && f.zip && f.city);
    companyCountry = f.country_id ? await odoo.getCountryCodeById(f.country_id[0]) : '';
  }
  if (!hasAddress && ba.address1 && ba.zip && ba.city) hasAddress = true;
  if (!hasAddress && kind === 'vat' && vies.street) hasAddress = true;
  if (!hasAddress) reasons.push('geen adres');
  if (!taxId) reasons.push(`btw-taks "${TAX_NAME}" ontbreekt`);

  // 3. Regels en totaal.
  const { lines, notes } = taxId ? await buildLines(order, taxId) : { lines: [], notes: [] };
  reasons.push(...notes);
  const sum = lines.reduce((s, l) => s + l.price_unit * l.quantity, 0);
  const expected = Number(order.total_price);
  if (taxId && Math.abs(round2(sum) - expected) > 0.01) {
    reasons.push(`totaal ${round2(sum)} wijkt af van Shopify ${expected}`);
  }

  const n = await odoo.countConnectorInvoices();
  if (n < FIRST_DRAFTS) reasons.push(`eerste ${FIRST_DRAFTS} facturen blijven in concept (nr ${n + 1})`);

  // 4. Peppol en actie.
  const isBE = (companyCountry || (kind === 'vat' ? vatValue.slice(0, 2) : 'BE')) === 'BE';
  const peppol = kind === 'vat' && isBE && peppolState === 'valid';
  const email = info.email || (order.customer && order.customer.email) || order.email || '';

  let action;
  if (reasons.length) action = `concept (${reasons.join('; ')})`;
  else if (kind === 'registry') action = 'boeken + mail (geen btw-nummer)';
  else if (peppol) action = 'boeken + Peppol + mail';
  else if (isBE) action = 'boeken, niet versturen (PEPPOL-ONTBREEKT)';
  else action = 'boeken + mail';

  return {
    kind, vatValue, digits, existingId, companyName, email, peppol, peppolState,
    method: paymentMethod(order), total: expected, action, reasons, lines, vies, isBE,
    nummer: kind === 'registry' ? `ondernemingsnr ${digits}` : `btw ${vatValue || normVat(info.vat)}`,
  };
}

function logPlan(order, plan) {
  const cust = [order.customer && order.customer.first_name, order.customer && order.customer.last_name].filter(Boolean).join(" ") || (order.billing_address && [order.billing_address.first_name, order.billing_address.last_name].filter(Boolean).join(" ")) || "";
  log(
    `[factuur] ${order.name} | klant ${cust || '-'} | bedrijf ${plan.companyName} | ${plan.nummer}` +
    ` | totaal ${plan.total.toFixed(2)} incl. btw | betaling ${plan.method}` +
    ` | partner ${plan.existingId ? plan.existingId : 'nieuw'}` +
    ` | Peppol ${plan.peppol ? 'ja' : 'nee'} (${plan.peppolState || 'onbekend'})` +
    ` | mail naar ${plan.email || '-'} | ${plan.action}`
  );
}

/** Live: uitvoeren van het plan. Alleen aangeroepen als niet dry-run. */
async function executePlan(order, plan) {
  const ref = `SHOP-${order.name.replace('#', '')}`;
  const date = (order.created_at || '').slice(0, 10);

  // Bedrijf: bestaand, of aanmaken op btw-nummer of ondernemingsnummer.
  const { id: companyId, created } = plan.kind === 'vat'
    ? await odoo.findOrCreateCompanyByVat({ name: plan.companyName, vat: plan.vatValue })
    : await odoo.findOrCreateCompanyByRegistry({ name: plan.companyName, digits: plan.digits });
  if (created) log(`[factuur] ${order.name}: bedrijf aangemaakt (${plan.nummer}).`);

  // Contactpersoon.
  const bill = order.billing_address || {};
  const personName = [bill.first_name || (order.customer && order.customer.first_name), bill.last_name || (order.customer && order.customer.last_name)]
    .filter(Boolean).join(' ') || plan.email;
  const personId = plan.email ? await odoo.findOrCreatePersonUnder(companyId, { name: personName, email: plan.email }) : null;

  // Adres aanvullen (overschrijft niets).
  const ba = order.billing_address || {};
  const vies = plan.vies;
  await odoo.fillCompanyAddress(companyId, {
    street: ba.address1 || (vies && vies.street) || '',
    zip: ba.zip || (vies && vies.zip) || '',
    city: ba.city || (vies && vies.city) || '',
    countryCode: ba.country_code || (plan.kind === 'vat' ? plan.vatValue.slice(0, 2) : 'BE'),
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

  // Verzenden. Peppol wordt nu pas echt gecontroleerd, op het bedrijf zoals het
  // in Odoo staat (ook een net aangemaakt bedrijf, ook op ondernemingsnummer).
  const state = await odoo.checkPeppol(companyId);
  const viaPeppol = state === 'valid';
  let finalAction;
  if (viaPeppol) finalAction = 'boeken + Peppol + mail';
  else if (plan.kind === 'vat' && plan.isBE) finalAction = 'boeken, niet versturen (PEPPOL-ONTBREEKT)';
  else finalAction = 'boeken + mail';
  if (finalAction !== plan.action) log(`[factuur] ${order.name}: na Peppol-controle (${state || 'onbekend'}): ${finalAction}.`);
  if (finalAction.includes('PEPPOL-ONTBREEKT')) {
    log(`::warning::[factuur] ${order.name}: PEPPOL-ONTBREEKT. Belgisch btw-nummer ${plan.vatValue} staat niet op Peppol. Geboekt, niet verstuurd: neem contact op met de klant.`);
  }
  const sends = !finalAction.includes('PEPPOL-ONTBREEKT');
  if (viaPeppol) await odoo.setPeppolIfVerified(companyId);
  if (sends) {
    if (!SEND_ENABLED) {
      log(`[factuur] ${order.name}: verzending UIT (INVOICE_SEND_ENABLED). Zou ${viaPeppol ? 'via Peppol + ' : ''}mail naar ${plan.email} gaan.`);
    } else {
      await odoo.sendInvoice(invoiceId, { viaPeppol, mailPartnerId: personId });
      log(`[factuur] ${order.name}: verzonden ${viaPeppol ? 'via Peppol + ' : ''}per mail naar ${plan.email}.`);
    }
  }
}

/**
 * Btw-gegevens van een bestelling:
 *  - webshop: uit het bedrijfsveld van de checkout ("Bedrijfsnaam en btw-nummer"),
 *    eerst het factuuradres, dan het verzendadres;
 *  - POS: uit het klantgegevens-formulier (metafields), zoals voorheen.
 */
async function vatInfoFor(order) {
  if (order.source_name !== 'pos') {
    for (const addr of [order.billing_address, order.shipping_address]) {
      const hit = addr && extractVatFromText(addr.company);
      if (hit) return { vat: hit.vat, company: hit.company, email: order.email || order.contact_email || '' };
    }
    return null;
  }
  if (!order.customer) return null; // anonieme POS-verkoop
  return shopify.getCustomerVatInfo(order.customer.id);
}

export async function syncInvoices() {
  const taxId = await odoo.getTaxIdByName(TAX_NAME);
  const orders = await shopify.listPosOrdersNeedingInvoice({ sinceDays: 7, invoiceTag: INVOICE_TAG, includeWeb: true });
  const dry = config.service.dryRun;
  let n = 0;

  for (const order of orders) {
    if (SKIP_ORDER_NAMES.has(order.name)) continue;
    let info;
    try {
      info = await vatInfoFor(order);
    } catch (err) {
      log(`[factuur] FOUT ${order.name} bij het lezen van het btw-nummer:`, err.message);
      continue;
    }
    if (!info || !normVat(info.vat)) continue; // geen nummer ingevuld
    const infoN = { ...info, vat: normVat(info.vat) };
    if (infoN.vat.replace(/^BE/, '') === OWN_VAT_DIGITS) {
      log(`[factuur] ${order.name}: btw-nummer van TJM zelf -> overslaan.`);
      continue;
    }
    n += 1;

    let plan;
    try {
      plan = await planOrder(order, infoN, taxId);
      logPlan(order, plan);
    } catch (err) {
      log(`[factuur] FOUT ${order.name} bij het plannen (niets geboekt, volgende run opnieuw):`, err.message);
      continue;
    }
    if (dry) continue;

    // Hoogstens één factuur per bestelling: het label komt VOOR het boeken.
    // Lukt het boeken of versturen niet, dan label factuur-fout en een
    // waarschuwing; die bestelling wordt nooit automatisch opnieuw gefactureerd.
    await shopify.tagOrderSynced(order, INVOICE_TAG);
    order.tags = [order.tags, INVOICE_TAG].filter(Boolean).join(', ');
    try {
      await executePlan(order, plan);
    } catch (err) {
      log(`::warning::[factuur] FOUT ${order.name} na het labelen: ${err.message}. Met de hand nakijken in Odoo.`);
      try { await shopify.tagOrderSynced(order, ERROR_TAG); } catch (e) { log('[factuur] label factuur-fout mislukt:', e.message); }
    }
  }
  log(`[factuur] ${n} bestelling(en) met btw- of ondernemingsnummer zonder factuur${dry ? ' (dry-run)' : ''}.`);
}
