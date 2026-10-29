# Odoo ⇄ Shopify voorraadconnector

Bidirectionele voorraadsync tussen **Shopify** (webshop + POS) en **Odoo Online (SaaS, v20)** voor Atelier Marhaban.

## Wat het doet

| Trigger | Gevolg |
|---|---|
| Verkoop op Shopify-webshop of Shopify POS | `orders/create`-webhook → Odoo on-hand wordt verlaagd |
| Odoo-offerte aangemaakt (`draft`/`sent`) | Regels worden gereserveerd → Shopify available zakt |
| Offerte-`validity_date` verstreken | Reservering valt automatisch weg → Shopify available komt terug open |
| Offerte bevestigd, levering, B2B e-commerce of handmatige Odoo-aanpassing | Poller herberekent `free_qty` → zet Shopify available gelijk |

**Odoo is leidend.** De aan Shopify getoonde voorraad wordt berekend als:

```
Shopify available = Odoo free_qty − aantal gereserveerd door open (niet-verlopen) offertes
```

- `free_qty` = on-hand minus reserveringen van **bevestigde** orders (Odoo's eigen berekening).
- Open offerte = `sale.order` in state `draft` of `sent`, met `validity_date` leeg of vandaag/later. Is de datum verstreken, dan telt de offerte niet meer mee en stijgt de voorraad vanzelf bij de volgende poll (binnen `POLL_INTERVAL_SECONDS`).

Matching gebeurt op **SKU**: `default_code` in Odoo ↔ `sku` van de Shopify-variant. Producten zonder SKU worden overgeslagen.

> **Architectuurkeuze:** Odoo Online (SaaS) laat geen custom modules of uitgaande webhooks toe. Daarom gebruiken we de **externe API (XML-RPC)** in beide richtingen: webhooks vangen Shopify-verkopen op, een poller (elke `POLL_INTERVAL_SECONDS`) detecteert Odoo-wijzigingen via `stock.quant.write_date`.

## Setup

### 1. Afhankelijkheden
```bash
cd odoo-shopify-connector
npm install
cp .env.example .env   # vul daarna de waarden in
```

### 2. Odoo API-sleutel
- Log in op `ateliermarhaban.odoo.com` met de integratie-gebruiker.
- Profiel → **Account Security** → **API-sleutels** → nieuwe sleutel → zet in `ODOO_API_KEY`.
- Zorg dat die gebruiker leesrechten op **Voorraad** heeft (en schrijfrechten op voorraadtellingen).
- Controleer `ODOO_LOCATION_NAME` (de volledige naam, bv. `WH/Stock`). Leeg = alle interne locaties samengeteld (lezen); schrijven gebeurt altijd op de eerste interne locatie.

### 3. Shopify custom app
- Shopify admin → **Instellingen → Apps en verkoopkanalen → Apps ontwikkelen** → nieuwe app.
- Admin API scopes: `read_products`, `read_inventory`, `write_inventory`, `read_orders`, `read_locations`, `write_webhooks`.
- Installeer de app, kopieer het **Admin API access token** (`shpat_...`) naar `SHOPIFY_ACCESS_TOKEN`.
- Kopieer het **API secret** van de app naar `SHOPIFY_WEBHOOK_SECRET` (gebruikt voor HMAC-verificatie).

### 4. Verbinding testen
```bash
npm run test-connection
```
Dit toont o.a. de beschikbare Shopify-locaties. Zet het juiste id in `SHOPIFY_LOCATION_ID`.

### 5. Deploy (automatisch 24/7 draaien)

De service moet continu draaien zodat de webhook verkopen opvangt en de poller Odoo blijft uitlezen. Er zit een `Dockerfile` en een Render-blueprint (`render.yaml`) bij voor een vrijwel kant-en-klare deploy.

**Aanbevolen: Render (1-klik blueprint)**
1. Ga naar [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint** → kies deze GitHub-repo.
2. Render leest `render.yaml` en maakt de service aan (altijd-aan `starter`-plan, Frankfurt, met persistente schijf voor `state.json`).
3. Vul in het dashboard de secrets in (ze staan op `sync: false`): de `ODOO_*`- en `SHOPIFY_*`-waarden, en `PUBLIC_URL` = de URL die Render je geeft (bv. `https://odoo-shopify-connector.onrender.com`).
4. Deploy. De service start automatisch de webhook-server én de poller, en herstart vanzelf bij een crash of na een nieuwe commit.

> Gebruik geen gratis plan: free web services vallen in slaap, waardoor de poller stopt en webhooks traag reageren.

Andere hosts (Railway, Fly.io, een eigen VPS) werken ook via de `Dockerfile` — zet daar dezelfde env-variabelen.

### 6. Webhook registreren (eenmalig)
Zodra de service draait op zijn publieke URL en `PUBLIC_URL` gezet is, registreer je de Shopify-webhook één keer. Dit kan lokaal of vanaf de server:
```bash
npm run register-webhooks   # registreert orders/create -> PUBLIC_URL/webhooks/orders
```
Daarna loopt alles automatisch: elke Shopify-verkoop (web/POS) triggert de webhook, en de poller synct Odoo-wijzigingen elke `POLL_INTERVAL_SECONDS`.

**Tip:** zet eerst `DRY_RUN=true`, controleer de logs een dag, en zet daarna op `false`.

## Belangrijke aandachtspunten

- **Loop-preventie:** na elke schrijfactie onthoudt `state.json` de laatst gezette waarde per SKU (5 min). Een "echo" (dezelfde waarde die terugkomt) wordt genegeerd. Omdat we enkel op `orders/create` luisteren (niet op inventory-webhooks), ontstaat er sowieso geen harde oneindige lus.
- **DRY_RUN=true** logt alle wijzigingen zonder iets weg te schrijven — gebruik dit bij de eerste test.
- **Bron van waarheid:** Odoo is leidend. Bij een Shopify-verkoop wordt Odoo relatief verlaagd (`-aantal`); daarna herberekent de poller de Shopify-available uit `free_qty` minus offerte-reserveringen.
- **Offerte-reservering & vrijgave:** de vrijgave is datum-gestuurd op `validity_date`. Zet dus bij elke offerte waarbij je wil reserveren een geldigheidsdatum in Odoo — zonder datum blijft de reservering staan tot de offerte bevestigd of geannuleerd wordt. De vrijgave gebeurt bij de eerstvolgende poll ná middernacht van de vervaldag; verlaag `POLL_INTERVAL_SECONDS` voor snellere reactie.
- **Dubbele telling vermijden:** omdat de reservering op open offertes zit en `free_qty` al bevestigde orders verrekent, mag je dezelfde order niet én als offerte laten staan én apart in Shopify aftrekken. Bevestig of annuleer offertes netjes in Odoo.
- **Betrouwbaarheid:** de poller schuift `lastOdooPoll` niet op bij een fout, zodat niets verloren gaat. De set actief gereserveerde SKU's staat in `state.json`, zodat een SKU ook herberekend wordt zodra zijn reservering wegvalt. Voor productie: draai achter een proces-manager (pm2/systemd) of als container met restart-policy.

## Bestanden
```
src/config.js   env-config
src/odoo.js     XML-RPC client (voorraad lezen/schrijven/polling)
src/shopify.js  Admin API client + webhook-HMAC-verificatie
src/sync.js     sync-logica beide richtingen + loop-guard
src/server.js   Express webhook-server (start ook de poller)
src/poller.js   Odoo → Shopify polling-loop
src/state.js    persistente staat (laatste poll + echo-cache)
scripts/        test-connection, register-webhooks
Dockerfile      container-image voor deploy
render.yaml     Render blueprint (1-klik deploy, altijd-aan + schijf)
```
