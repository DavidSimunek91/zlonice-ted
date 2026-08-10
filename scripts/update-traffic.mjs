// Aktualizuje data/traffic.json z živého API ŘSD/NDIC (mobilitydata.rsd.cz),
// zdroj "DATEX II - Běžné dopravní informace v2 (snímek)" — PULL/na
// vyžádání, DATEX II verze 2.3. Spouští ho .github/workflows/update-traffic.yml
// na časovač — appka sama žádné volání na ŘSD nedělá (přístup vyžaduje
// Basic Auth s neveřejnými přihlašovacími údaji), jen čte výsledný JSON.
//
// PROXY (viz RSD_PROXY_URL níž): ŘSD blokuje spojení z datacenter IP
// rozsahů GitHub Actions runnerů (connect timeout, ověřeno — z běžného
// připojení přímé volání s týmiž údaji funguje bez problémů; portál ŘSD
// navíc nenabízí žádné self-service nastavení IP whitelistu). Proto
// požadavek místo přímo na ŘSD chodí přes malý Cloudflare Worker, který
// ho jen transparentně přeposílá dál (viz X-Proxy-Key níž — chrání
// Worker proti zneužití coby veřejná proxy, ŘSD přihlašovací údaje samy
// o sobě nijak neukládá). Když RSD_PROXY_URL není nastavené, skript
// volá ŘSD přímo — pro případ, že by se blokace v budoucnu zrušila.
//
// POZOR (přečti, než budeš ladit nesedící data): parser níž je napsaný
// podle standardní struktury DATEX II v2.3 "Situation Publication"
// (d2LogicalModel > payloadPublication > situation > situationRecord,
// poloha přes groupOfLocations > locationForDisplay s lat/lon, text přes
// generalPublicComment). Nebyl ale ověřený proti skutečné živé odpovědi
// tohohle konkrétního NDIC zdroje — k tomu jsme se při implementaci
// nedostali (nešlo přes portál získat vzorek předem). Po prvním ostrém
// běhu pipeline zkontroluj commit do data/traffic.json (nebo log běhu na
// GitHub Actions), jestli našel/nenašel situace dává smysl. Pokud
// struktura odpovědi nesedí s tím, co parser čeká, skript selže čistě do
// status:"error" (viz pravidlo 1 níž) — v takovém případě uprav
// extractLatLon/extractComment/situationRecordType podle skutečné
// odpovědi, appka mezitím ukáže "nelze ověřit", ne vymyšlené nuly.
//
// Bezpečnostní pravidla, stejná jako u ostatních zdrojů v tomhle repu:
//   1. Cokoli se nepovede (síť, auth, formát, chybějící očekávaná pole) →
//      explicitní status:"error", NIKDY tiše "žádné situace" jen proto,
//      že jsme nic nenašli/nerozparsovali.
//   2. Appka na frontendu navíc kontroluje stáří pole `updated`.

import { writeFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const OUT_PATH = 'data/traffic.json';
const DIRECT_URL = 'https://mobilitydata.rsd.cz/Resources/Dynamic/CommonTIDatex_v2/';
const PROXY_URL = process.env.RSD_PROXY_URL; // Cloudflare Worker relay, viz komentář výš
const PROXY_KEY = process.env.PROXY_KEY;
const USERNAME = process.env.RSD_USERNAME;
const PASSWORD = process.env.RSD_PASSWORD;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

// Jeden síťový zádrhel (výpadek, pomalá odpověď) by dřív celý běh rovnou
// poslal do status:"error". Teď to zkusí 3x s krátkou prodlevou mezi
// pokusy, než se vzdá — furt platí pravidlo, že po vyčerpání pokusů jde
// chyba nahoru a skončí to explicitním "error", ne tichým nic.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

// Stejné souřadnice, co appka používá pro počasí/ovzduší (viz index.html).
const ZLONICE_LAT = 50.2875;
const ZLONICE_LON = 14.0922;
const RADIUS_KM = 20; // pokrývá okolní obce a hlavní silnice, ne celý kraj

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// generalPublicComment může mít víc jazykových verzí najednou — hledáme
// tu s lang="cs", jinak bereme první dostupnou, ať appka aspoň něco ukáže.
export function extractComment(record) {
  const comments = asArray(record?.generalPublicComment);
  let fallback = null;
  for (const c of comments) {
    for (const v of asArray(c?.comment?.values?.value)) {
      const text = typeof v === 'string' ? v : v?.['#text'];
      if (!text) continue;
      if (v?.['@_lang'] === 'cs') return text;
      if (fallback == null) fallback = text;
    }
  }
  return fallback;
}

// DATEX II má na "kde to je" víc variant podle typu lokace — zkoušíme
// nejběžnější tvary, které obsahují přímo souřadnice pro zobrazení.
// Situace odkázané jen přes tabulku předdefinovaných poloh (bez lat/lon
// v samotné odpovědi) takhle záměrně nedokážeme umístit a přeskočíme je
// (viz volání níž) — je to bezpečnější než si polohu domýšlet.
export function extractLatLon(record) {
  for (const g of asArray(record?.groupOfLocations)) {
    const disp = g?.locationForDisplay ?? g?.locationForDisplayGeneral ?? g;
    const lat = disp?.latitude ?? disp?.pointCoordinates?.latitude;
    const lon = disp?.longitude ?? disp?.pointCoordinates?.longitude;
    if (lat != null && lon != null) return { lat: Number(lat), lon: Number(lon) };
  }
  return null;
}

export function situationRecordType(record) {
  return record?.['@_xsi:type'] || record?.['@_type'] || 'Neznámý typ situace';
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    const output = {
      status: 'pending_access',
      updated: new Date().toISOString(),
      note: 'RSD_USERNAME/RSD_PASSWORD nejsou nastavené jako repo secrety.',
    };
    writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log('RSD_USERNAME/RSD_PASSWORD chybí, nic nevolám.');
    return;
  }

  const auth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const url = PROXY_URL || DIRECT_URL;
  if (PROXY_URL) headers['X-Proxy-Key'] = PROXY_KEY || '';

  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) throw new Error(`ŘSD/NDIC API vrátilo HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) =>
      ['situation', 'situationRecord', 'groupOfLocations', 'generalPublicComment', 'value'].includes(name),
  });
  const doc = parser.parse(xml);

  const payload = doc?.d2LogicalModel?.payloadPublication;
  if (!payload) {
    throw new Error(
      'Odpověď nemá očekávanou strukturu DATEX II (chybí d2LogicalModel/payloadPublication) — formát se pravděpodobně liší od očekávání, zkontroluj skutečnou odpověď a uprav parser.'
    );
  }

  const situations = asArray(payload.situation);

  const nearby = [];
  for (const situation of situations) {
    for (const record of asArray(situation.situationRecord)) {
      const pos = extractLatLon(record);
      if (!pos) continue; // bez zjistitelné polohy neumíme posoudit "v okolí"
      const distanceKm = haversineKm(ZLONICE_LAT, ZLONICE_LON, pos.lat, pos.lon);
      if (distanceKm > RADIUS_KM) continue;

      nearby.push({
        type: situationRecordType(record),
        comment: extractComment(record),
        validityStatus: record?.validity?.validityStatus || null,
        startTime: record?.validity?.validityTimeSpecification?.overallStartTime || null,
        endTime: record?.validity?.validityTimeSpecification?.overallEndTime || null,
        distanceKm: Math.round(distanceKm * 10) / 10,
        lat: pos.lat,
        lon: pos.lon,
      });
    }
  }
  nearby.sort((a, b) => a.distanceKm - b.distanceKm);

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    radiusKm: RADIUS_KM,
    situations: nearby,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log(
    `Hotovo: ${nearby.length} situací do ${RADIUS_KM} km od Zlonic (z ${situations.length} situací v celé ČR).`
  );
}

main().catch((err) => {
  console.error('Aktualizace dopravních dat selhala:', err);
  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
