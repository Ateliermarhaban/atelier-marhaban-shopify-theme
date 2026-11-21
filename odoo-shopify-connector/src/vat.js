// Belgische nummers: btw-nummer (BE + 10 cijfers) en ondernemingsnummer (10 cijfers).
// Beide hebben dezelfde controle: de eerste 8 cijfers mod 97 = 97 - laatste 2 cijfers.

/**
 * Geeft de 10 cijfers terug als het een geldig Belgisch nummer is (met of zonder
 * BE-prefix, met of zonder punten/spaties), anders null.
 */
export function parseBeNumber(raw) {
  let s = String(raw || '').toUpperCase().replace(/[\s.\-]/g, '');
  if (/^BE\d{10}$/.test(s)) s = s.slice(2);
  if (!/^\d{10}$/.test(s)) return null;
  const base = Number(s.slice(0, 8));
  const check = Number(s.slice(8));
  return 97 - (base % 97) === check ? s : null;
}

/** true als de waarde een BE-btw-nummer (met BE-prefix) is. */
export function isBeVatPrefixed(raw) {
  return /^BE\s*[\d.\s]{10,}$/i.test(String(raw || '').trim()) && parseBeNumber(raw) !== null;
}

const EU_PREFIX = '(?:AT|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)';

/**
 * Haalt een btw- of ondernemingsnummer uit vrije tekst, zoals het veld
 * "Bedrijfsnaam en btw-nummer" in de checkout ("Awelja bv BE 0797.047.218").
 * Geeft { vat, company } terug, of null als er geen bruikbaar nummer in staat.
 *  - Belgisch nummer (met of zonder BE, punten, spaties; ook oude 9 cijfers):
 *    vat = 'BE' + 10 cijfers, alleen als de mod-97-controle klopt.
 *  - Ander EU-land: vat = landcode + nummer (VIES controleert later).
 * company = de tekst zonder het nummer en zonder woorden als "btw", "BTW-nr:".
 */
export function extractVatFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let vat = null;
  let found = '';

  {
    // Ander EU-land (eerst, zodat 'DE 123456789' niet als Belgisch nummer telt): landcode in hoofdletters, dan 8 tot 12 tekens zonder spaties.
    const eu = text.match(new RegExp(`\\b${EU_PREFIX}\\s?[0-9A-Z]{2}[0-9A-Z.]{6,12}\\b`));
    if (eu) {
      const v = eu[0].replace(/[\s.]/g, '');
      if (/^[A-Z]{2}[0-9A-Z]{8,12}$/.test(v) && /\d{6,}/.test(v)) { vat = v; found = eu[0]; }
    }
  }
  // Belgisch: met of zonder BE (ook vastgeschreven: BE0797047218), punten of spaties.
  const be = vat ? null : text.match(/(?:\bBE\s*|\b)([01]?\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/i);
  if (be) {
    let digits = be[1].replace(/[\s.]/g, '');
    if (digits.length === 9) digits = `0${digits}`;
    const ok = parseBeNumber(digits);
    // Ongeldige controle: toch doorgeven, zodat de factuur in concept blijft en
    // de fout in de log staat (in plaats van stil geen factuur te maken).
    vat = ok ? `BE${ok}` : `BE${digits}`;
    found = be[0];
  }
  if (!vat) return null;

  const company = text
    .replace(found, ' ')
    .replace(/\b(btw|tva|vat|ust)[\s-]*(nr|nummer|number|n°|no)?\.?\s*:?/gi, ' ')
    .replace(/\b(ondernemingsnummer|ondernemingsnr|kbo)\.?\s*:?/gi, ' ')
    .replace(/[\s,;:/|()-]+$/g, '')
    .replace(/^[\s,;:/|()-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { vat, company };
}
