// Klant-/adressynchronisatie tussen Shopify en Odoo (beide richtingen).
//
// Scope (Odoo-kant): alle contacten met e-mail die GEEN leverancier zijn
// (supplier_rank = 0), ook met customer_rank 0. Interne sub-adressen en
// gebruikers worden overgeslagen (zie odoo.listSyncablePartners).
//
// Gedrag:
//  - Nieuw: ontbrekende klant in de andere richting aanmaken (match op e-mail).
//  - Aanvullen: bij een bestaande match lege velden vullen in BEIDE richtingen
//    (adres, telefoon, bedrijfsnaam, btw). Een GEVULD veld wordt nooit
//    overschreven; afwijkingen worden gelogd als [verschil].
//  - Veldmapping bedrijfsnaam/btw volgt het /pages/klantgegevens-formulier:
//    Shopify customer-metafields custom.bedrijfsnaam / custom.btw_nummer
//    <-> Odoo company_name / vat.
//  - Marketing: een Odoo-klant die al koopt (customer_rank > 0) wordt bij het
//    aanmaken in Shopify op ingeschreven gezet (single opt-in, bron
//    "bestaande klant"). Alle andere nieuwe contacten zonder toestemming.
//    Bestaande inschrijvingen worden nooit gewijzigd, dus wie zich in Shopify
//    heeft uitgeschreven blijft uitgeschreven.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const norm = (email) => (email || '').trim().toLowerCase();
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const val = (v) => (v === null || v === undefined ? '' : String(v).trim());
const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();
let bSubscribed = 0; // nieuwe Shopify-klanten met marketingtoestemming (richting B)

/** Odoo-partnergegevens uit een Shopify-klant (voor aanmaken in Odoo). */
function partnerFromShopifyCustomer(c) {
  const addr = c.default_address || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || c.company_name || addr.company || c.email;
  return {
    name,
    email: c.email,
    phone: c.phone || addr.phone || '',
    street: addr.address1 || '',
    street2: addr.address2 || '',
    city: addr.city || '',
    zip: addr.zip || '',
    countryCode: addr.country_code || '',
    company_name: c.company_name || addr.company || '',
    vat: c.vat || '',
  };
}

/** Shopify-klant uit een Odoo-partner (voor aanmaken in Shopify). */
async function shopifyCustomerFromPartner(p) {
  const [firstName, ...rest] = (p.name || '').trim().split(' ');
  const lastName = rest.join(' ');
  const countryCode = p.country_id ? await odoo.getCountryCodeById(p.country_id[0]) : null;
  const address = (p.street || p.city || p.zip)
    ? {
        address1: p.street || '',
        address2: p.street2 || '',
        city: p.city || '',
        zip: p.zip || '',
        phone: p.phone || '',
        ...(p.company_name ? { company: p.company_name } : {}),
        ...(countryCode ? { country_code: countryCode } : {}),
      }
    : null;
  return {
    email: p.email,
    firstName: firstName || p.email,
    lastName,
    phone: p.phone || '',
    address,
    companyName: p.company_name || '',
    vat: p.vat || '',
    // "bestaande klant" = koopt al in Odoo -> single opt-in in Shopify.
    subscribe: (p.customer_rank || 0) > 0,
  };
}

export async function syncCustomers() {
  const [shopCustomers, odooPartners, odooAllEmails] = await Promise.all([
    shopify.listAllCustomers(),
    odoo.listSyncablePartners(),
    odoo.getAllPartnerEmails(),
  ]);
  const shopByEmail = new Map(shopCustomers.map((c) => [norm(c.email), c]).filter(([e]) => e));
  const odooByEmail = new Map(odooPartners.map((p) => [norm(p.email), p]).filter(([e]) => e));
  const shopEmails = new Set(shopByEmail.keys());
  const dry = config.service.dryRun;
  log(`[klanten] Shopify: ${shopCustomers.length}, Odoo (syncbaar): ${odooPartners.length}.`);

  // === Richting A: Shopify -> Odoo (aanmaken + Odoo-velden aanvullen) ===
  let aNew = 0, aFilled = 0, aDiff = 0;
  for (const c of shopCustomers) {
    const email = norm(c.email);
    if (!email) continue;

    if (!odooAllEmails.has(email)) {
      // Nieuw: partner aanmaken.
      const data = partnerFromShopifyCustomer(c);
      aNew++;
      if (dry) { log(`[klanten][DRY][A] Odoo-partner aanmaken: ${data.email} (${data.name}).`); continue; }
      try { await odoo.createCustomerPartner(data); log(`[klanten][A] Odoo-partner aangemaakt: ${data.email}.`); }
      catch (err) { log(`[klanten][A] FOUT aanmaken ${data.email}:`, err.message); aNew--; }
      continue;
    }

    // Bestaat al: lege Odoo-velden aanvullen vanuit Shopify.
    const p = odooByEmail.get(email);
    if (!p) continue; // in Odoo maar niet syncbaar (bv. leverancier) -> met rust laten
    const addr = c.default_address || {};
    const shopCountry = addr.country_code || '';
    const fields = [
      ['phone', c.phone || addr.phone || '', val(p.phone)],
      ['street', addr.address1 || '', val(p.street)],
      ['street2', addr.address2 || '', val(p.street2)],
      ['city', addr.city || '', val(p.city)],
      ['zip', addr.zip || '', val(p.zip)],
    ];
    const update = {};
    let filledThis = false, diffThis = false;
    for (const [key, shopVal, odooVal] of fields) {
      if (isEmpty(odooVal) && !isEmpty(shopVal)) { update[key] = shopVal; filledThis = true; }
      else if (!isEmpty(odooVal) && !isEmpty(shopVal) && odooVal !== shopVal) {
        diffThis = true;
        log(`[verschil][${email}] ${key}: Odoo "${odooVal}" <-> Shopify "${shopVal}" (niet overschreven).`);
      }
    }
    // Land apart (code-vergelijking).
    const odooCountry = p.country_id ? await odoo.getCountryCodeById(p.country_id[0]) : '';
    if (isEmpty(odooCountry) && !isEmpty(shopCountry)) { update.countryCode = shopCountry; filledThis = true; }
    else if (!isEmpty(odooCountry) && !isEmpty(shopCountry) && odooCountry !== shopCountry) {
      diffThis = true;
      log(`[verschil][${email}] land: Odoo "${odooCountry}" <-> Shopify "${shopCountry}" (niet overschreven).`);
    }

    // Bedrijf/btw: persoon koppelen aan een bedrijf via parent_id. Een bestaande
    // parent_id wordt nooit overschreven (linkPartnerToCompany controleert dat).
    const shopCompany = c.company_name || addr.company || '';
    const shopVat = c.vat || '';
    if (!p.parentId && (shopCompany || shopVat)) {
      filledThis = true;
      if (dry) log(`[klanten][DRY][A] Bedrijf koppelen ${email}: ${shopCompany || shopVat}.`);
      else {
        try { await odoo.linkPartnerToCompany(p.id, { name: shopCompany, vat: shopVat }); log(`[klanten][A] Bedrijf gekoppeld ${email}.`); }
        catch (err) { log(`[klanten][A] FOUT bedrijf ${email}:`, err.message); }
      }
    }
    if (!isEmpty(p.company_name) && !isEmpty(shopCompany) && val(p.company_name) !== val(shopCompany)) {
      diffThis = true; log(`[verschil][${email}] bedrijfsnaam: Odoo "${val(p.company_name)}" <-> Shopify "${val(shopCompany)}" (niet overschreven).`);
    }
    if (!isEmpty(p.vat) && !isEmpty(shopVat) && normVat(p.vat) !== normVat(shopVat)) {
      diffThis = true; log(`[verschil][${email}] btw: Odoo "${val(p.vat)}" <-> Shopify "${val(shopVat)}" (niet overschreven).`);
    }

    if (diffThis) aDiff++;
    if (filledThis) {
      aFilled++;
      if (dry) log(`[klanten][DRY][A] Odoo aanvullen ${email}: ${Object.keys(update).join(', ')}.`);
      else {
        try { await odoo.updatePartnerFields(p.id, update); log(`[klanten][A] Odoo aangevuld ${email}: ${Object.keys(update).join(', ')}.`); }
        catch (err) { log(`[klanten][A] FOUT aanvullen ${email}:`, err.message); aFilled--; }
      }
    }
  }

  // === Richting B: Odoo -> Shopify (aanmaken + Shopify-velden aanvullen) ===
  let bNew = 0, bFilled = 0, bDiff = 0;
  for (const p of odooPartners) {
    const email = norm(p.email);
    if (!email) continue;

    if (!shopEmails.has(email)) {
      const data = await shopifyCustomerFromPartner(p);
      bNew++;
      if (data.subscribe) bSubscribed++;
      if (dry) { log(`[klanten][DRY][B] Shopify-klant aanmaken: ${data.email}${data.subscribe ? ' (ingeschreven, bron bestaande klant)' : ''}.`); continue; }
      try { await shopify.createCustomer(data); log(`[klanten][B] Shopify-klant aangemaakt: ${data.email}.`); }
      catch (err) { log(`[klanten][B] FOUT aanmaken ${data.email}:`, err.message); bNew--; }
      continue;
    }

    // Bestaat al: lege Shopify-velden aanvullen vanuit Odoo.
    const c = shopByEmail.get(email);
    if (!c) continue;
    const addr = c.default_address || {};
    const odooCountry = p.country_id ? await odoo.getCountryCodeById(p.country_id[0]) : '';

    let filledThis = false, diffThis = false;
    // Telefoon (native).
    let nativePhone = null;
    if (isEmpty(c.phone) && !isEmpty(p.phone)) { nativePhone = val(p.phone); filledThis = true; }
    else if (!isEmpty(c.phone) && !isEmpty(p.phone) && val(c.phone) !== val(p.phone)) {
      diffThis = true; log(`[verschil][${email}] telefoon: Shopify "${val(c.phone)}" <-> Odoo "${val(p.phone)}" (niet overschreven).`);
    }
    // Adres (native): alleen aanvullen als Shopify nog GEEN standaardadres heeft
    // (per-veld samenvoegen op een bestaand adres vergt het adres-id; dat vermijden
    // we om niets te overschrijven).
    let newAddress = null;
    if (!c.default_address && (p.street || p.city || p.zip)) {
      newAddress = {
        address1: p.street || '', address2: p.street2 || '', city: p.city || '',
        zip: p.zip || '', phone: p.phone || '',
        ...(p.company_name ? { company: p.company_name } : {}),
        ...(odooCountry ? { country_code: odooCountry } : {}),
      };
      filledThis = true;
    } else if (c.default_address && (p.street || p.city || p.zip)) {
      // Bestaand adres: alleen afwijkingen melden.
      const pairs = [['straat', addr.address1, p.street], ['postcode', addr.zip, p.zip], ['gemeente', addr.city, p.city]];
      for (const [k, s, o] of pairs) {
        if (!isEmpty(s) && !isEmpty(o) && val(s) !== val(o)) {
          diffThis = true; log(`[verschil][${email}] ${k}: Shopify "${val(s)}" <-> Odoo "${val(o)}" (niet overschreven).`);
        }
      }
    }
    // Metafields bedrijfsnaam / btw.
    const mf = {};
    for (const [key, shopVal, odooVal, label] of [
      ['companyName', c.company_name, p.company_name, 'bedrijfsnaam'],
      ['vat', c.vat, p.vat, 'btw'],
    ]) {
      if (isEmpty(shopVal) && !isEmpty(odooVal)) { mf[key] = val(odooVal); filledThis = true; }
      else if (!isEmpty(shopVal) && !isEmpty(odooVal) && val(shopVal) !== val(odooVal)) {
        diffThis = true; log(`[verschil][${email}] ${label}: Shopify "${val(shopVal)}" <-> Odoo "${val(odooVal)}" (niet overschreven).`);
      }
    }

    if (diffThis) bDiff++;
    if (filledThis) {
      bFilled++;
      const parts = [nativePhone ? 'telefoon' : null, newAddress ? 'adres' : null, ...Object.keys(mf)].filter(Boolean);
      if (dry) log(`[klanten][DRY][B] Shopify aanvullen ${email}: ${parts.join(', ')}.`);
      else {
        try {
          if (nativePhone || newAddress) await shopify.updateCustomerNative(c.id, { phone: nativePhone || undefined, address: newAddress || undefined });
          if (Object.keys(mf).length) await shopify.setCustomerMetafields(c.gid, mf);
          log(`[klanten][B] Shopify aangevuld ${email}: ${parts.join(', ')}.`);
        } catch (err) { log(`[klanten][B] FOUT aanvullen ${email}:`, err.message); bFilled--; }
      }
    }
  }

  const w = dry ? 'zou' : '';
  log(`[klanten] Richting A (Shopify->Odoo): ${w} nieuw ${aNew}, aangevuld ${aFilled}, verschillend ${aDiff}.`);
  log(`[klanten] Richting B (Odoo->Shopify): ${w} nieuw ${bNew} (waarvan ${bSubscribed} met toestemming, bron bestaande klant), aangevuld ${bFilled}, verschillend ${bDiff}.`);
}
