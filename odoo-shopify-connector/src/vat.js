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
