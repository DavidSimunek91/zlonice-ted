// Aktualizuje data/winter-roads.json ze živého API ŘSD/NDIC
// (mobilitydata.rsd.cz) — zdroj "DDR - Zimní sjízdnost (snímek)"
// (registr.dopravniinfo.cz, id zdroje cz-ndic_ddr-winter-pull), formát DDR
// XML v3.2.5 pro zimní zpravodajství. Spouští ho
// .github/workflows/update-winter-roads.yml na časovač (fallback/ruční
// spuštění, viz infra/do-pipelines) — appka sama žádné volání na ŘSD
// nedělá, jen čte výsledný JSON.
//
// DŮLEŽITÉ: tohle je SAMOSTATNÝ odběr, ne tentýž jako u scripts/update-
// traffic.mjs — a na rozdíl od původního předpokladu NEsdílí přihlašovací
// údaje s dopravou. Portál ke každému odběru generuje VLASTNÍ Basic Auth
// dvojici (náhodný hex login, ne zvolené jméno portálového účtu) — proto
// RSD_WINTER_USERNAME/RSD_WINTER_PASSWORD níž, oddělené od RSD_USERNAME/
// RSD_PASSWORD u dopravy. Cílová URL (ověřeno přímo na portálu
// mobilitydata.rsd.cz, ne odhad): /Resources/Dynamic/WinterTIDDR/.
//
// Zdroj je navíc SEZÓNNÍ — mimo zimní sezónu ho ŘSD podle registru vůbec
// neposkytuje. Prázdný/nedostupný výsledek mimo sezónu tedy neznamená
// chybu pipeline, jen že zrovna nejsou žádná hlášení (appka to i tak umí
// ukázat jako "klidno", ne jako chybu — pokud ovšem API samo vrátí
// rozumnou prázdnou odpověď, ne HTTP chybu).
//
// POZOR (přečti, než budeš ladit nesedící/chybějící data): na rozdíl od
// update-traffic.mjs, kde byl parser aspoň napsaný podle běžné obecné
// struktury DATEX II v2.3, u tohodle zdroje se NEPODAŘILO ověřit přesnou
// strukturu XML vůbec — dokumentace (XSD/RNC schéma, ukázky) je na
// registr.dopravniinfo.cz, které z téhle buildovací/CI sítě není
// dosažitelné (stejný typ blokace datacenter IP, co má i samotné API, viz
// komentář v update-traffic.mjs). Nehádáme proto konkrétní názvy elementů
// — parseWinterXml() níž udělá jen obecný rozklad XML a hledá cokoli, co
// vypadá jako opakovaný záznam s textovým komentářem; pokud si nebude
// jistý, skončí explicitním status:"error" a do zprávy přidá seznam
// nalezených klíčů na první a druhé úrovni XML, aby šlo podle TOHO
// (skutečná odpověď, ne dokumentace) parser doladit. To je přesně ten
// samý postup "po prvním ostrém běhu zkontroluj a oprav", co je popsaný
// v update-traffic.mjs — tady ho jen říkáme dopředu, protože tu nemáme
// ani tu základní jistotu z obecného DATEX II tvaru.
//
// Filtrování: tenhle zdroj hlásí sjízdnost podle oblastí/úseků silnic, ne
// podle lat/lon bodů (na rozdíl od dopravních situací) — proto se nefiltruje
// Haversine okruhem, ale podle toho, jestli text oblasti/úseku obsahuje
// jedno z NEARBY_KEYWORDS níž (kraj + hlavní silnice kolem Zlonic). Dokud
// neuvidíme skutečnou odpověď, nevíme jistě, v jakém poli to bude — hledá
// se proto v libovolném textovém poli nalezeného záznamu.
//
// PROXY: droplet je u ŘSD potvrzeně blokovaný (viz infra/rsd-relay/README.md
// a home-proxy/README.md) — produkční cesta je přes domácí proxy na MSI
// notebooku (home-proxy/server.mjs), ne přímé volání z droplu. Proxy
// přeposílá Basic Auth hlavičku beze změny (sám žádné přihlašovací údaje
// nezná, jen sdílený PROXY_KEY) a cílovou cestu vybírá podle cesty
// požadavku z pevné allowlisty — RSD_PROXY_URL + "/winter" tedy jde na
// stejný proxy jako doprava (RSD_PROXY_URL samotné, bez cesty), jen na
// jinou cílovou ŘSD URL. Stejný proxy server, stejný PROXY_KEY, žádná
// nová hodnota na notebooku navíc.
//
// Bezpečnostní pravidla, stejná jako u ostatních zdrojů v tomhle repu:
//   1. Cokoli se nepovede (síť, auth, formát, chybějící očekávaná pole) →
//      NIKDY tiše "žádná hlášení" jen proto, že jsme nic nenašli/
//      nerozparsovali. Když ale existují poslední DOBRÁ data, necháváme
//      je beze změny místo přepsání chybou (viz main().catch() níž).
//   2. Appka na frontendu navíc kontroluje stáří pole `updated`.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const OUT_PATH = 'data/winter-roads.json';
const DIRECT_URL = 'https://mobilitydata.rsd.cz/Resources/Dynamic/WinterTIDDR/';
const PROXY_URL = process.env.RSD_PROXY_URL; // domácí proxy na MSI notebooku, viz komentář výš
const PROXY_KEY = process.env.PROXY_KEY;
const USERNAME = process.env.RSD_WINTER_USERNAME;
const PASSWORD = process.env.RSD_WINTER_PASSWORD;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

// Kraj + hlavní silnice v okolí Zlonic — viz komentář výš, proč
// filtrujeme podle textu místo souřadnic.
const NEARBY_KEYWORDS = ['středočesk', 'kladno', 'slaný', 'zlonice', 'i/16', 'i/61', 'i/7', 'd7'];

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

export function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// Posbírá všechny řetězcové hodnoty z objektu (do hloubky), ať je
// najdeme, v jakémkoli poli skutečná odpověď text o oblasti/sjízdnosti
// uloží — viz komentář o filtrování výš.
function collectStrings(node, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (key.startsWith('@_')) continue; // atributy neřešíme, jen text
      collectStrings(node[key], out);
    }
  }
}

function matchesNearby(strings) {
  const joined = strings.join(' | ').toLowerCase();
  return NEARBY_KEYWORDS.some((kw) => joined.includes(kw));
}

// Zkusí v rozparsovaném XML najít opakující se pole objektů (typický tvar
// "záznamů" v XML podle ŘSD) a z každého vytáhnout jen text — viz hlavní
// POZOR komentář na začátku souboru, proč nejdeme po konkrétních názvech
// elementů. Když nic takového nenajde, vrátí null (ne prázdné pole) a
// main() z toho udělá explicitní status:"error" s diagnostikou struktury.
export function findRecordArrays(doc) {
  const found = [];
  function walk(node) {
    if (Array.isArray(node) && node.length > 0 && node.every((n) => n != null && (typeof n === 'object' || typeof n === 'string'))) {
      found.push(node);
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('@_')) continue;
        walk(node[key]);
      }
    }
  }
  walk(doc);
  return found.length > 0 ? found : null;
}

export function topLevelShape(doc) {
  const rootKeys = Object.keys(doc || {});
  const parts = rootKeys.map((k) => {
    const child = doc[k];
    const childKeys = child && typeof child === 'object' && !Array.isArray(child) ? Object.keys(child) : [];
    return childKeys.length ? `${k} > [${childKeys.join(', ')}]` : k;
  });
  return parts.join(' ; ') || '(prázdný dokument)';
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    const output = {
      status: 'pending_access',
      updated: new Date().toISOString(),
      note: 'RSD_WINTER_USERNAME/RSD_WINTER_PASSWORD nejsou nastavené jako secrety.',
    };
    writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log('RSD_WINTER_USERNAME/RSD_WINTER_PASSWORD chybí, nic nevolám.');
    return;
  }

  const auth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const url = PROXY_URL ? PROXY_URL.replace(/\/?$/, '/winter') : DIRECT_URL;
  if (PROXY_URL) headers['X-Proxy-Key'] = PROXY_KEY || '';

  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) throw new Error(`ŘSD/NDIC API (zimní sjízdnost) vrátilo HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);

  const recordArrays = findRecordArrays(doc);
  if (!recordArrays) {
    throw new Error(
      `Odpověď neobsahuje žádné rozpoznatelné pole záznamů — struktura XML se pravděpodobně liší od očekávání. Nalezená struktura: ${topLevelShape(doc)}. Uprav findRecordArrays/parseWinterXml podle skutečné odpovědi.`
    );
  }

  const reports = [];
  for (const arr of recordArrays) {
    for (const record of arr) {
      const strings = [];
      collectStrings(record, strings);
      if (strings.length === 0) continue;
      if (!matchesNearby(strings)) continue;
      reports.push({ text: strings.join(' — ') });
    }
  }

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    reports,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log(`Hotovo: ${reports.length} hlášení o sjízdnosti v okolí Zlonic.`);
}

main().catch((err) => {
  console.error('Aktualizace dat o sjízdnosti selhala:', err);

  let previousWasOk = false;
  try {
    if (existsSync(OUT_PATH)) {
      previousWasOk = JSON.parse(readFileSync(OUT_PATH, 'utf-8'))?.status === 'ok';
    }
  } catch {
    // Poškozený/nečitelný předchozí soubor — nemáme co zachovat.
  }

  if (previousWasOk) {
    console.log('Poslední data byla v pořádku, ponechávám je beze změny místo přepsání chybou.');
    return;
  }

  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
