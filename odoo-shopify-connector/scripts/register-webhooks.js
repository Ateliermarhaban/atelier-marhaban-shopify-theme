import { shopifyFetch } from '../src/shopify.js';
import { config } from '../src/config.js';

// Registreert de orders/create webhook die zowel webshop- als POS-verkopen dekt.
async function main() {
  if (!config.service.publicUrl) {
    throw new Error('Stel PUBLIC_URL in (.env) voordat je webhooks registreert.');
  }
  const address = `${config.service.publicUrl}/webhooks/orders`;

  const existing = await shopifyFetch('/webhooks.json');
  const already = (existing.webhooks || []).find(
    (w) => w.topic === 'orders/create' && w.address === address
  );
  if (already) {
    console.log(`Webhook bestaat al (id ${already.id}) -> ${address}`);
    return;
  }

  const created = await shopifyFetch('/webhooks.json', {
    method: 'POST',
    body: {
      webhook: {
        topic: 'orders/create',
        address,
        format: 'json',
      },
    },
  });
  console.log(`Webhook aangemaakt (id ${created.webhook.id}) -> ${address}`);
  console.log('\nLET OP: zet het webhook-signing-secret uit je custom app-instellingen');
  console.log('in SHOPIFY_WEBHOOK_SECRET (Shopify admin > Instellingen > Meldingen/Webhooks,');
  console.log('of de API-credentials van je custom app).');
}

main().catch((err) => {
  console.error('Registratiefout:', err.message);
  process.exit(1);
});
