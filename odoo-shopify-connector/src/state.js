import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// STATE_FILE kan via env naar een persistente schijf wijzen (bv. op Render),
// zodat de poll-status een herstart van de container overleeft.
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastOdooPoll: null, recent: {}, activeSkus: [] };
  }
}

function save(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = load();

export function getLastOdooPoll() {
  return state.lastOdooPoll;
}

export function setLastOdooPoll(isoDatetime) {
  state.lastOdooPoll = isoDatetime;
  save(state);
}

/**
 * SKU's die bij de vorige poll door open offertes gereserveerd waren.
 * Nodig om een SKU opnieuw te berekenen zodra zijn reservering wegvalt.
 */
export function getActiveSkus() {
  return state.activeSkus || [];
}

export function setActiveSkus(skus) {
  state.activeSkus = skus;
  save(state);
}

/**
 * Loop-guard: onthoud dat we een SKU zojuist naar een bepaalde qty hebben gezet,
 * zodat we een echo-wijziging (dezelfde waarde terug zien komen) kunnen negeren.
 * TTL in milliseconden.
 */
const TTL_MS = 5 * 60 * 1000;

export function markSynced(sku, qty) {
  state.recent[sku] = { qty, at: Date.now() };
  save(state);
}

export function wasJustSynced(sku, qty) {
  const entry = state.recent[sku];
  if (!entry) return false;
  if (Date.now() - entry.at > TTL_MS) {
    delete state.recent[sku];
    save(state);
    return false;
  }
  return entry.qty === qty;
}
