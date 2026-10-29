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
    accessToken: required('SHOPIFY_ACCESS_TOKEN'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-01',
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
