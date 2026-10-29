import express from 'express';
import { config } from './config.js';
import { verifyWebhook } from './shopify.js';
import { applyShopifySaleToOdoo, log } from './sync.js';
import { startPoller } from './poller.js';

const app = express();

// Raw body nodig voor HMAC-verificatie.
app.use('/webhooks', express.raw({ type: 'application/json' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhooks/orders', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyWebhook(req.body, hmac)) {
    log('[webhook] Ongeldige HMAC — geweigerd.');
    return res.status(401).send('invalid hmac');
  }

  // Direct 200 terug zodat Shopify niet opnieuw probeert; verwerking async.
  res.status(200).send('ok');

  try {
    const order = JSON.parse(req.body.toString('utf8'));
    const source = order.source_name || 'onbekend'; // 'web', 'pos', ...
    log(`[webhook] orders/create ontvangen (bron: ${source}, id: ${order.id}).`);
    await applyShopifySaleToOdoo(order);
  } catch (err) {
    log('[webhook] Verwerkingsfout:', err.message);
  }
});

app.listen(config.service.port, () => {
  log(`Connector draait op poort ${config.service.port} (dry-run: ${config.service.dryRun}).`);
  // Start de Odoo -> Shopify poller in hetzelfde proces.
  startPoller();
});
