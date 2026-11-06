// Klant-/adressynchronisatie tussen Shopify en Odoo.
// Richting: beide. Scope: alleen echte klanten (Shopify-klanten <-> Odoo-partners
// met customer_rank > 0). Matching op e-mail, create-if-new: een bestaand adres
// wordt nooit opnieuw aangemaakt, dus geen dubbels en geen oneindige lus.

import * as odoo from './odoo.js';
import * as shopify from './shopify.js';
import { config } from './config.js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const norm = (email) => (email || '').trim().toLowerCase();

/** Bouw Odoo-partnergegevens uit een Shopify-klant. */
function partnerFromShopifyCustomer(c) {
  const addr = c.default_address || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || addr.company
    || c.email;
  return {
    name,
    email: c.email,
    phone: c.phone || addr.phone || '',
    street: addr.address1 || '',
    street2: addr.address2 || '',
    city: addr.city || '',
    zip: addr.zip || '',
    countryCode: addr.country_code || '',
  };
}

/** Bouw een Shopify-klant (met adres) uit een Odoo-partner. */
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
        ...(countryCode ? { country_code: countryCode } : {}),
      }
    : null;
  return {
    email: p.email,
    firstName: firstName || p.email,
    lastName,
    phone: p.phone || '',
    address,
  };
}

export async function syncCustomers() {
  // Alle bronnen één keer ophalen.
  const [shopCustomers, odooCustomers, odooEmails] = await Promise.all([
    shopify.listAllCustomers(),
    odoo.listCustomerPartners(),
    odoo.getAllPartnerEmails(),
  ]);
  const shopEmails = new Set(shopCustomers.map((c) => norm(c.email)).filter(Boolean));
  log(`[klanten] Shopify: ${shopCustomers.length}, Odoo-klanten: ${odooCustomers.length}.`);

  // Richting A: Shopify-klant -> Odoo (partner aanmaken als e-mail nog niet bestaat).
  let createdInOdoo = 0;
  for (const c of shopCustomers) {
    if (!c.email || odooEmails.has(norm(c.email))) continue;
    const data = partnerFromShopifyCustomer(c);
    if (config.service.dryRun) {
      log(`[klanten][DRY] Odoo-partner aanmaken: ${data.email} (${data.name}).`);
      createdInOdoo++;
      continue;
    }
    try {
      await odoo.createCustomerPartner(data);
      createdInOdoo++;
      log(`[klanten] Odoo-partner aangemaakt: ${data.email}.`);
    } catch (err) {
      log(`[klanten] FOUT Odoo-partner ${data.email}:`, err.message);
    }
  }

  // Richting B: Odoo-klant -> Shopify (klant aanmaken als e-mail nog niet bestaat).
  let createdInShopify = 0;
  for (const p of odooCustomers) {
    if (!p.email || shopEmails.has(norm(p.email))) continue;
    const data = await shopifyCustomerFromPartner(p);
    if (config.service.dryRun) {
      log(`[klanten][DRY] Shopify-klant aanmaken: ${data.email}.`);
      createdInShopify++;
      continue;
    }
    try {
      await shopify.createCustomer(data);
      createdInShopify++;
      log(`[klanten] Shopify-klant aangemaakt: ${data.email}.`);
    } catch (err) {
      log(`[klanten] FOUT Shopify-klant ${data.email}:`, err.message);
    }
  }

  log(`[klanten] ${config.service.dryRun ? 'zou aanmaken' : 'aangemaakt'} -> Odoo: ${createdInOdoo}, Shopify: ${createdInShopify}.`);
}
