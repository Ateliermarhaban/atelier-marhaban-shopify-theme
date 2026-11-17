# Odoo ↔ Shopify connector: samenvatting

## Wat het doet
Een gratis connector die Atelier Marhaban-data gelijk houdt tussen **Odoo** (offertes, B2B-webshop, voorraad) en **Shopify** (webshop + POS).

1. **Voorraad (beide richtingen, Odoo leidend)**
   - Shopify → Odoo: elke nieuwe Shopify-bestelling (web en POS) wordt in Odoo als voorraadbeweging afgeboekt per SKU. Elke order krijgt het label `odoo-synced`, zodat niets dubbel geboekt wordt.
   - Odoo → Shopify: per SKU zet de connector de Shopify-voorraad gelijk aan **free_qty in Odoo minus de reserveringen van open offertes**. Offertes reserveren stock; een offerte die na haar `validity_date` verlopen is, geeft de reservering automatisch weer vrij.
   - Volgorde per run: eerst Shopify → Odoo, dan Odoo → Shopify.
   - **Uitzondering:** order **#AM1009** (POS, 8/11, SKU 105708-125-OB) wordt bewust nooit geboekt. Die SKU wordt handmatig op 0 gezet.
   - Elke run logt per SKU waar Shopify en Odoo verschillen (`[verschil]`).

2. **Klanten en adressen (beide richtingen)**
   - Scope Odoo: alle contacten met e-mail die **geen leverancier** zijn (`supplier_rank = 0`). Interne sub-adressen en gebruikers worden overgeslagen.
   - Matching op **e-mailadres**.
   - Nieuwe klant in de ene omgeving → aangemaakt in de andere.
   - Bestaande klant → **lege velden** worden aangevuld (adres, telefoon, bedrijfsnaam, btw). **Gevulde velden worden nooit overschreven**; afwijkingen komen in de log als `[verschil]`.
   - Bedrijfsnaam en btw-nummer volgen het formulier `/pages/klantgegevens`: Shopify-metafields `custom.bedrijfsnaam` en `custom.btw_nummer` ↔ Odoo `company_name` en `vat`.
   - **Marketing:** een Odoo-klant met minstens één aankoop wordt bij aanmaken in Shopify op *ingeschreven* gezet (single opt-in, bron "bestaande klant"). Andere nieuwe contacten zonder toestemming. Bestaande inschrijvingen worden nooit gewijzigd; wie zich in Shopify heeft uitgeschreven, blijft uitgeschreven.
   - Uit te zetten met repo-variabele `SYNC_CUSTOMERS=false`.

## Hoe het draait
- **GitHub Actions** (gratis, de repo is publiek, dus geen minutenlimiet). Geen server nodig, de laptop hoeft niet aan.
- Eén run blijft ~5,5 uur draaien en synchroniseert elke **5 minuten**. Daarna start de run zichzelf opnieuw.
- Een cron (elke 30 min) is het vangnet als de keten ooit stopt.
- Shopify-auth: Dev Dashboard-app "Odoo voorraadconnector", client_credentials (token per run). De app moet geïnstalleerd blijven.
- Geheimen (client-id/secret, Odoo-sleutel) staan in GitHub Secrets, niet in de code.
- Schakelaars als repo-variabelen: `DRY_RUN`, `SYNC_INTERVAL_MIN`, `SYNC_LOOP`, `SYNC_CUSTOMERS`.

## Status (11/11)
- Voorraadsync live-code staat op `main` (commits `93ae014`, `6b783c8`, gemergd via `63ea987`).
- **`DRY_RUN` staat nog op `true`**: er wordt niets naar Odoo of Shopify geschreven, alleen gelogd.
- De eerstvolgende DRY-run op de nieuwe code is nog niet gelezen: een oudere run (#80) draait op een oude commit en blokkeert de wachtrij tot ~5 uur. Na die run start de nieuwe code vanzelf.
- Pas `DRY_RUN` op `false` nadat de DRY-cijfers (nieuw / aangevuld / verschillend, per richting) zijn goedgekeurd.

## Belangrijk om te weten
- Shopify-scopes `read_customers` en `write_customers` zijn toegevoegd en geaccordeerd.
- Repo is publiek. Geen wachtwoorden of tokens in de code of in logs.
- Synced orders worden door het label `odoo-synced` herkend; verwijder dat label niet handmatig.
