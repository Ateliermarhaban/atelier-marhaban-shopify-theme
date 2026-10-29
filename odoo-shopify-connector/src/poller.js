import { config } from './config.js';
import { getChangedStockSince, getOpenQuotationReservations } from './odoo.js';
import { syncAvailableForSkus, log } from './sync.js';
import { getLastOdooPoll, setLastOdooPoll, getActiveSkus, setActiveSkus } from './state.js';

// Odoo verwacht datetimes in UTC, formaat 'YYYY-MM-DD HH:MM:SS'.
function odooDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function pollOnce() {
  const since = getLastOdooPoll();
  // Nieuw startpunt vastleggen vóór de query, zodat we niets missen tussen query en volgende poll.
  const now = odooDatetime(new Date());

  try {
    // 1. Open (niet-verlopen) offertes -> reserveringen per SKU.
    const reservations = await getOpenQuotationReservations();

    // 2. Voorraad die sinds de vorige poll in Odoo wijzigde (free_qty-basis).
    const changed = await getChangedStockSince(since);
    const changedSkus = changed.map((c) => c.sku);

    // 3. SKU's die vorige keer gereserveerd waren maar nu niet meer
    //    (offerte verlopen/bevestigd/geannuleerd) moeten we herberekenen,
    //    anders blijft Shopify op de oude, verlaagde waarde staan.
    const previouslyActive = getActiveSkus();

    const candidates = new Set([
      ...reservations.keys(),
      ...changedSkus,
      ...previouslyActive,
    ]);

    if (candidates.size) {
      log(`[poller] ${candidates.size} kandidaat-SKU('s) (offertes: ${reservations.size}, gewijzigd: ${changedSkus.length}).`);
      await syncAvailableForSkus(candidates, reservations);
    }

    // Actieve reserveringsset onthouden voor de volgende poll.
    setActiveSkus([...reservations.keys()]);
    setLastOdooPoll(now);
  } catch (err) {
    log('[poller] FOUT:', err.message);
    // lastOdooPoll niet opschuiven bij fout, zodat we het opnieuw proberen.
  }
}

export function startPoller() {
  const intervalMs = config.service.pollIntervalSeconds * 1000;
  log(`[poller] Start, interval ${config.service.pollIntervalSeconds}s.`);
  // Eerste run na een korte vertraging.
  setTimeout(function loop() {
    pollOnce().finally(() => setTimeout(loop, intervalMs));
  }, 3000);
}

// Sta toe om de poller los te draaien: `npm run poll`.
if (import.meta.url === `file://${process.argv[1]}`) {
  pollOnce().then(() => process.exit(0));
}
