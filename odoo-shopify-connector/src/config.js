import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Ontbrekende verplichte env-variabele: ${name}`);
  }
  return value;
}

export const config = {
  odoo: {
    url: required('ODOO_URL').replace(/\/$/, ''),
    db: required('ODOO_DB'),
    username: required('ODOO_USERNAME'),
    apiKey: required('ODOO_API_KEY'),
    locationName: process.env.ODOO_LOCATION_NAME || '',
  },
  shopify: {
    shop: required('SHOPIFY_SHOP'),
    // Authenticatie: ofwel een vast access token, ofwel client_id + client_secret
    // (nieuwe Dev Dashboard; token wordt dan per run opgehaald via client_credentials).
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
    locationId: process.env.SHOPIFY_LOCATION_ID || '',
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  },
  service: {
    port: parseInt(process.env.PORT || '3000', 10),
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '120', 10),
    dryRun: String(process.env.DRY_RUN).toLowerCase() === 'true',
  },
};
