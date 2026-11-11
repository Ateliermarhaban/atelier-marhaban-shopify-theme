// Klant-/adressynchronisatie tussen Shopify en Odoo (beide richtingen).
//
// Scope: alle contacten met e-mail die GEEN leverancier zijn (Odoo) en alle
// Shopify-klanten. Eigen adressen (@atelier-marhaban.com) worden overgeslagen.
//
// Gedrag:
//  - Matching op e-mail. Per e-mailadres één Odoo-record: het persoon-record
//    heeft voorrang boven het bedrijfsrecord met hetzelfde adres.
//  - Nieuw: ontbrekende klant in de andere richting aanmaken.
//  - Aanvullen: lege velden vullen in beide richtingen. Gevulde velden worden
//    nooit overschreven; afwijkingen komen in de log als [verschil].
//  - Bedrijfsnaam/btw: Shopify-metafields custom.bedrijfsnaam / custom.btw_nummer
//    <-> Odoo het gekoppelde bedrijf (parent_id). Persoon koppelen via parent_id,
//    nooit een bestaande koppeling overschrijven.
//  - Telefoon: vergelijken genormaliseerd (alleen cijfers en +). Naar Shopify
//    alleen geldige E.164-nummers, op het standaardadres (niet op de klant).
//    Is het nummer al bij een andere klant in gebruik, dan overslaan en loggen.
//  - Marketing: Odoo-koper (customer_rank > 0) wordt bij aanmaken in Shopify op
//    ingeschreven (single opt-in, bron "bestaande klant"). Bestaande
//    inschrijvingen worden nooit gewijzigd.
//  - Per run wordt een Shopify-klant maximaal één keer bijgewerkt.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const OWN_DOMAIN = '@atelier-marhaban.com';
const norm = (email) => (email || '').trim().toLowerCase();
const isOwn = (email) => norm(email).endsWith(OWN_DOMAIN);
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const val = (v) => (v === null || v === undefined ? '' : String(v).trim());
const normVat = (v) => String(v || '').replace(/[\s.]/g, '').toUpperCase();

// Odoo-labels die als Shopify-tag met dezelfde naam meegaan. Alleen toevoegen.
const TAG_LABELS = new Set([
  'B2B', 'Detailzaak', 'Interieurarchitect', 'Project', 'Tegelbedrijf',
  'Verdeler', 'Prospect', 'Zwembadbouwer', 'Mailing B2B',
]);
const ODOO_TAG = 'Odoo';
const MAILING_LABEL = 'Mailing B2B';
/** Tags die op een Odoo-klant horen: "Odoo" plus de bekende labels van de contactpersoon. */
const wantedTags = (p) => [ODOO_TAG, ...(p.labels || []).filter((l) => TAG_LABELS.has(l))];
const wantsMailing = (p) => (p.labels || []).includes(MAILING_LABEL);

/** Telefoon genormaliseerd naar +cijfers. Leeg als het niet te herleiden is. */
function normPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  if (digits.startsWith('00')) return '+' + digits.slice(2).replace(/\D/g, '');
  if (digits.startsWith('0')) return '+32' + digits.slice(1).replace(/\D/g, ''); // Belgisch lokaal nummer
  return '';
}
/** E.164: + gevolgd door 8-15 cijfers, eerste cijfer niet 0. */
const isE164 = (p) => /^\+[1-9]\d{7,14}$/.test(p);

/** Eén Odoo-record per e-mailadres: persoon voorrang boven bedrijf. */
function dedupeOdooByEmail(partners) {
  const byEmail = new Map();
  for (const p of partners) {
    const e = norm(p.email);
    if (!e || isOwn(e)) continue;
    const existing = byEmail.get(e);
    if (!existing || (existing.is_company && !p.is_company)) byEmail.set(e, p);
  }
  return byEmail;
}

/** Odoo-partnergegevens uit een Shopify-klant (voor aanmaken in Odoo). */
function partnerFromShopifyCustomer(c) {
  const addr = c.default_address || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || c.company_name || addr.company || c.email;
  return {
    name,
    email: c.email,
    phone: normPhone(c.phone || addr.phone) || '',
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
  const phone = normPhone(p.phone);
  const hasAddress = !!(p.street || p.city || p.zip);
  const address = hasAddress
    ? {
        address1: p.street || '',
        address2: p.street2 || '',
        city: p.city || '',
        zip: p.zip || '',
        // Telefoon op het adres, niet op de klant zelf.
        ...(isE164(phone) ? { phone } : {}),
        ...(p.company_name ? { company: p.company_name } : {}),
        ...(countryCode ? { country_code: countryCode } : {}),
      }
    : null;
  return {
    email: p.email,
    firstName: firstName || p.email,
    lastName,
    address,
    companyName: p.company_name || '',
    vat: p.vat || '',
    subscribe: (p.customer_rank || 0) > 0,
    phoneDropped: !!phone && !hasAddress, // zonder adres geen plek voor telefoon
  };
}

export async function syncCustomers() {
  const [allShopCustomers, allOdooPartners, odooAllEmails] = await Promise.all([
    shopify.listAllCustomers(),
    odoo.listSyncablePartners(),
    odoo.getAllPartnerEmails(),
  ]);
  const shopCustomers = allShopCustomers.filter((c) => !isOwn(c.email) && norm(c.email));
  const shopByEmail = new Map(shopCustomers.map((c) => [norm(c.email), c]));
  const odooByEmail = dedupeOdooByEmail(allOdooPartners);
  const odooPartners = [...odooByEmail.values()];
  const shopEmails = new Set(shopByEmail.keys());
  const dry = config.service.dryRun;
  log(`[klanten] Shopify: ${shopCustomers.length}, Odoo (één per e-mail): ${odooPartners.length}.`);

  // Telefoon-eigenaar per genormaliseerd nummer (klant én adres), om dubbel gebruik te voorkomen.
  const phoneOwner = new Map();
  for (const c of shopCustomers) {
    for (const raw of [c.phone, c.default_address && c.default_address.phone]) {
      const p = normPhone(raw);
      if (isE164(p) && !phoneOwner.has(p)) phoneOwner.set(p, c.id);
    }
  }

  // === Richting A: Shopify -> Odoo ===
  let aNew = 0, aFilled = 0, aDiff = 0;
  for (const c of shopCustomers) {
    const email = norm(c.email);

    if (!odooAllEmails.has(email)) {
      const data = partnerFromShopifyCustomer(c);
      aNew++;
      if (dry) { log(`[klanten][DRY][A] Odoo-partner aanmaken: ${data.email} (${data.name}).`); continue; }
      try { await odoo.createCustomerPartner(data); log(`[klanten][A] Odoo-partner aangemaakt: ${data.email}.`); }
      catch (err) { log(`[klanten][A] FOUT aanmaken ${data.email}:`, err.message); aNew--; }
      continue;
    }

    const p = odooByEmail.get(email);
    if (!p) continue; // alleen een bedrijfsrecord of leverancier: met rust laten
    const addr = c.default_address || {};
    const shopCountry = addr.country_code || '';
    const shopPhone = normPhone(c.phone || addr.phone);
    const odooPhone = normPhone(p.phone);
    const fields = [
      ['phone', isE164(shopPhone) ? shopPhone : '', odooPhone],
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
    const odooCountry = p.country_id ? await odoo.getCountryCodeById(p.country_id[0]) : '';
    if (isEmpty(odooCountry) && !isEmpty(shopCountry)) { update.countryCode = shopCountry; filledThis = true; }
    else if (!isEmpty(odooCountry) && !isEmpty(shopCountry) && odooCountry !== shopCountry) {
      diffThis = true; log(`[verschil][${email}] land: Odoo "${odooCountry}" <-> Shopify "${shopCountry}" (niet overschreven).`);
    }

    // Bedrijf: persoon koppelen aan bedrijf (alleen als er nog geen parent is).
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
    if (filledThis && Object.keys(update).length) {
      aFilled++;
      if (dry) log(`[klanten][DRY][A] Odoo aanvullen ${email}: ${Object.keys(update).join(', ')}.`);
      else {
        try { await odoo.updatePartnerFields(p.id, update); log(`[klanten][A] Odoo aangevuld ${email}: ${Object.keys(update).join(', ')}.`); }
        catch (err) { log(`[klanten][A] FOUT aanvullen ${email}:`, err.message); aFilled--; }
      }
    } else if (filledThis) {
      aFilled++; // alleen bedrijfskoppeling
    }
  }

  // === Richting B: Odoo -> Shopify ===
  let bNew = 0, bFilled = 0, bDiff = 0, bSubscribed = 0, bPhoneSkipped = 0, bTags = 0, bConsent = 0;
  const touchedShop = new Set(); // max één update per Shopify-klant per run
  for (const p of odooPartners) {
    const email = norm(p.email);

    if (!shopEmails.has(email)) {
      const data = await shopifyCustomerFromPartner(p);
      bNew++;
      if (data.subscribe) bSubscribed++;
      if (data.phoneDropped) log(`[klanten][B] Telefoon van ${email} overgeslagen: geen adres om het op te zetten.`);
      const tags = wantedTags(p);
      if (dry) {
        log(`[klanten][DRY][B] Shopify-klant aanmaken: ${data.email}${data.subscribe ? ' (ingeschreven, bron bestaande klant)' : ''}. Tags: ${tags.join(', ')}.`);
        if (wantsMailing(p) && !data.subscribe) log(`[klanten][DRY][B] Mailing B2B-toestemming zetten: ${data.email}.`);
        continue;
      }
      try {
        const created = await shopify.createCustomer(data);
        const gid = `gid://shopify/Customer/${created.id}`;
        log(`[klanten][B] Shopify-klant aangemaakt: ${data.email}.`);
        await shopify.addCustomerTags(gid, tags);
        log(`[klanten][B] Tags gezet ${data.email}: ${tags.join(', ')}.`);
        if (wantsMailing(p) && !data.subscribe) {
          await shopify.subscribeEmailMarketing(gid);
          bConsent++;
          log(`[klanten][B] Mailing B2B-toestemming gezet ${data.email} (single opt-in).`);
        }
      }
      catch (err) { log(`[klanten][B] FOUT aanmaken ${data.email}:`, err.message); bNew--; }
      continue;
    }

    const c = shopByEmail.get(email);
    if (!c) continue;
    if (touchedShop.has(c.id)) { log(`[klanten][B] ${email} al bijgewerkt in deze run, overslaan.`); continue; }
    const addr = c.default_address || {};
    const odooCountry = p.country_id ? await odoo.getCountryCodeById(p.country_id[0]) : '';

    let filledThis = false, diffThis = false;
    const parts = [];

    // Telefoon: genormaliseerd vergelijken; alleen geldig E.164; op het adres.
    const odooPhone = normPhone(p.phone);
    const shopPhone = normPhone(c.phone || addr.phone);
    if (isEmpty(shopPhone) && isE164(odooPhone)) {
      const owner = phoneOwner.get(odooPhone);
      if (owner !== undefined && owner !== c.id) {
        bPhoneSkipped++;
        log(`[klanten][B] Telefoon ${odooPhone} van ${email} overgeslagen: al in gebruik bij klant ${owner}.`);
      } else if (!isE164(odooPhone)) {
        bPhoneSkipped++;
        log(`[klanten][B] Telefoon van ${email} ongeldig (${p.phone}), overgeslagen.`);
      } else if (addr.id) {
        if (dry) { parts.push('telefoon (adres)'); filledThis = true; }
        else {
          try { await shopify.setAddressPhone(c.id, addr.id, odooPhone); parts.push('telefoon (adres)'); filledThis = true; touchedShop.add(c.id); phoneOwner.set(odooPhone, c.id); }
          catch (err) { log(`[klanten][B] FOUT telefoon ${email}:`, err.message); }
        }
      } else {
        log(`[klanten][B] Telefoon van ${email} overgeslagen: geen standaardadres.`);
        bPhoneSkipped++;
      }
    } else if (!isEmpty(shopPhone) && isE164(odooPhone) && shopPhone !== odooPhone) {
      diffThis = true; log(`[verschil][${email}] telefoon: Shopify "${shopPhone}" <-> Odoo "${odooPhone}" (niet overschreven).`);
    }

    // Adres: alleen aanmaken als Shopify nog geen standaardadres heeft.
    if (!c.default_address && (p.street || p.city || p.zip)) {
      const newAddress = {
        address1: p.street || '', address2: p.street2 || '', city: p.city || '',
        zip: p.zip || '',
        ...(isE164(odooPhone) ? { phone: odooPhone } : {}),
        ...(p.company_name ? { company: p.company_name } : {}),
        ...(odooCountry ? { country_code: odooCountry } : {}),
      };
      parts.push('adres');
      filledThis = true;
      if (dry) { /* gelogd in de samenvatting */ }
      else {
        try { await shopify.updateCustomerNative(c.id, { address: newAddress }); touchedShop.add(c.id); }
        catch (err) { log(`[klanten][B] FOUT adres ${email}:`, err.message); }
      }
    } else if (c.default_address && (p.street || p.city || p.zip)) {
      const pairs = [['straat', addr.address1, p.street], ['postcode', addr.zip, p.zip], ['gemeente', addr.city, p.city]];
      for (const [k, s, o] of pairs) {
        if (!isEmpty(s) && !isEmpty(o) && val(s) !== val(o)) {
          diffThis = true; log(`[verschil][${email}] ${k}: Shopify "${val(s)}" <-> Odoo "${val(o)}" (niet overschreven).`);
        }
      }
    }

    // Bedrijfsnaam / btw via metafields.
    const mf = {};
    for (const [key, shopVal, odooVal, label] of [
      ['companyName', c.company_name, p.company_name, 'bedrijfsnaam'],
      ['vat', c.vat, p.vat, 'btw'],
    ]) {
      if (isEmpty(shopVal) && !isEmpty(odooVal)) { mf[key] = val(odooVal); filledThis = true; parts.push(label); }
      else if (!isEmpty(shopVal) && !isEmpty(odooVal) && normVat(shopVal) !== normVat(odooVal) && key === 'vat') {
        diffThis = true; log(`[verschil][${email}] btw: Shopify "${val(shopVal)}" <-> Odoo "${val(odooVal)}" (niet overschreven).`);
      } else if (!isEmpty(shopVal) && !isEmpty(odooVal) && val(shopVal) !== val(odooVal)) {
        diffThis = true; log(`[verschil][${email}] ${label}: Shopify "${val(shopVal)}" <-> Odoo "${val(odooVal)}" (niet overschreven).`);
      }
    }

    // Tags: alleen toevoegen die er nog niet op staan. Tags die anderen zetten blijven staan.
    const missingTags = wantedTags(p).filter((t) => !(c.tags || []).includes(t));
    if (missingTags.length) {
      filledThis = true; parts.push(`tags ${missingTags.join(', ')}`); bTags++;
      if (dry) log(`[klanten][DRY][B] Tags ${email}: + ${missingTags.join(', ')}.`);
      else {
        try { await shopify.addCustomerTags(c.gid, missingTags); }
        catch (err) { log(`[klanten][B] FOUT tags ${email}:`, err.message); }
      }
    }
    // Mailing B2B: inschrijven alleen als de klant nu niet ingeschreven is. Uitgeschreven
    // (UNSUBSCRIBED) of in behandeling (PENDING) wordt nooit gewijzigd.
    if (wantsMailing(p)) {
      const state = c.marketingState || 'NOT_SUBSCRIBED';
      if (state === 'NOT_SUBSCRIBED' || state === '') {
        if (dry) { log(`[klanten][DRY][B] Mailing B2B-toestemming zetten: ${email} (nu ${state || 'leeg'}).`); bConsent++; }
        else {
          try { await shopify.subscribeEmailMarketing(c.gid); bConsent++; log(`[klanten][B] Mailing B2B-toestemming gezet ${email} (single opt-in).`); }
          catch (err) { log(`[klanten][B] FOUT toestemming ${email}:`, err.message); }
        }
      } else {
        log(`[klanten][B] Mailing B2B ${email}: toestemming ongewijzigd (${state}).`);
      }
    }

    if (diffThis) bDiff++;
    if (filledThis) {
      bFilled++;
      if (Object.keys(mf).length) {
        if (dry) log(`[klanten][DRY][B] Shopify metafields ${email}: ${Object.keys(mf).join(', ')}.`);
        else {
          try { await shopify.setCustomerMetafields(c.gid, mf); touchedShop.add(c.id); }
          catch (err) { log(`[klanten][B] FOUT metafields ${email}:`, err.message); }
        }
      }
      if (!dry && parts.length) log(`[klanten][B] Shopify aangevuld ${email}: ${parts.join(', ')}.`);
    }
  }

  const w = dry ? 'zou' : '';
  log(`[klanten] Richting A (Shopify->Odoo): ${w} nieuw ${aNew}, aangevuld ${aFilled}, verschillend ${aDiff}.`);
  log(`[klanten] Richting B (Odoo->Shopify): ${w} nieuw ${bNew} (waarvan ${bSubscribed} met toestemming, bron bestaande klant), aangevuld ${bFilled}, verschillend ${bDiff}, telefoon overgeslagen ${bPhoneSkipped}, tags bijgewerkt ${bTags}, Mailing B2B-toestemming ${bConsent}.`);
}
