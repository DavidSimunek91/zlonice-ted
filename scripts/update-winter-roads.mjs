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
// STRUKTURA ODPOVĚDI (ověřeno 2.11.2026 proti prvním ostrým běhům, viz
// commit historie data/winter-roads.json — ne jen dokumentace): parser
// stále nejde po konkrétních názvech XML elementů (findRecordArrays níž
// zůstává obecný), ale víme teď jistě, jaký TEXTOVÝ tvar jednotlivé
// záznamy mají. Každý záznam obsahuje mj. jeden "popis" řetězec v tvaru:
//   "<OBLAST> - Teplota od <X> do <Y>°C; Počasí: <...>; Dálnice: <...>;
//   Silnice I. třídy: <...>; ..."
// (<OBLAST> je buď správní obvod ŘSD, např. "Obvod 01 Slaný", nebo výčet
// čísel silnic + okres, např. "I/14, I/16, I/37 - okres Trutnov"). Tenhle
// jeden řetězec nese VŠECHNO podstatné pohromadě a dobře se parsuje
// rozdělením podle ";". Záznam ale navíc obsahuje i tutéž informaci
// rozpitvanou do jednotlivých dílčích polí zvlášť (teplota, stav počasí,
// srážky, vítr, viditelnost, sjízdnost po typu silnice) — ty se objeví v
// collectStrings() jako DALŠÍ, redundantní řetězce. Řešení: extractPopis()
// níž z nalezených řetězců vybere jen ten jeden nejbohatší "popis" (podle
// vzoru "Teplota od"), ignoruje zbytek — tím zmizí duplicity bez nutnosti
// cokoli ručně deduplikovat.
//
// Filtrování: tenhle zdroj hlásí sjízdnost podle oblastí/úseků silnic, ne
// podle lat/lon bodů (na rozdíl od dopravních situací) — proto se
// nefiltruje Haversine okruhem, ale podle toho, jestli <OBLAST> (ne celý
// text, viz AREA_KEYWORDS níž) obsahuje "Slaný" (Zlonice spadá pod ORP
// Slaný, stejný ověřený fakt jako u výstrah ČHMÚ v data/README.md) nebo
// "Středočeský". Záměrně NEfiltrujeme podle holých čísel silnic (např.
// "I/16") — ověřeno na živých datech, že stejné číslo silnice se objevuje
// i ve zcela vzdálených okresech (viz commit, co tohle opravil), takže by
// to dávalo falešné shody.
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

// Jen název oblasti/obvodu, ne čísla silnic — viz komentář o filtrování výš.
const AREA_KEYWORDS = ['slaný', 'středočesk'];

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

// Z posbíraných řetězců vybere ten jeden "popis" (nejbohatší shoda se
// vzorem "Teplota od X do Y°C; ..."), viz komentář o struktuře nahoře.
// Když nic takového není, vrátí null — main() pak pro ten záznam spadne
// zpět na obecné spojení všech řetězců (viz volání níž), ne na vymyšlenou
// strukturu.
export function extractPopis(strings) {
  const candidates = strings.filter((s) => /Teplota od/.test(s) && s.includes(';'));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

// Rozdělí "popis" na oblast + jednotlivé položky (teplota/počasí/silnice).
// Vzor viz komentář o struktuře nahoře. Co nerozpozná (jiný tvar položky,
// než počítáme), nezahodí — přidá do `extra`, ať appka ukáže aspoň
// surový text místo mlčení o reálné informaci.
export function parsePopis(popis) {
  const areaIdx = popis.indexOf(' - Teplota od');
  const area = areaIdx === -1 ? null : popis.slice(0, areaIdx).trim();
  const rest = areaIdx === -1 ? popis : popis.slice(areaIdx + 3).trim();

  const segments = rest.split(';').map((s) => s.trim()).filter(Boolean);
  let tempFrom = null;
  let tempTo = null;
  let weather = null;
  const roads = [];
  const extra = [];

  for (const seg of segments) {
    const tempMatch = seg.match(/^Teplota od (-?\d+) do (-?\d+)\s*°C$/);
    if (tempMatch) {
      tempFrom = Number(tempMatch[1]);
      tempTo = Number(tempMatch[2]);
      continue;
    }
    const weatherMatch = seg.match(/^Počasí:\s*(.+)$/);
    if (weatherMatch) {
      weather = weatherMatch[1];
      continue;
    }
    const roadMatch = seg.match(/^([^:]+):\s*(.+)$/);
    if (roadMatch) {
      roads.push({ type: roadMatch[1].trim(), condition: roadMatch[2].trim() });
      continue;
    }
    extra.push(seg);
  }

  return { area, tempFrom, tempTo, weather, roads, extra };
}

// Každý záznam nese 3 ISO časy — vznik záznamu, platnost od, platnost do
// — ale NE v týhle chronologické pořadí (vznik záznamu bývá těsně PO
// začátku platnosti, ne před ním, ověřeno na živých datech). Nejmenší čas
// je tedy spolehlivě "platnost od", největší "platnost do"; ten
// prostřední (vznik záznamu) appka nepotřebuje zobrazit.
export function extractValidity(strings) {
  const times = [...new Set(strings.filter((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s)))].sort();
  if (times.length < 2) return { validFrom: null, validTo: null };
  return { validFrom: times[0], validTo: times[times.length - 1] };
}

function matchesArea(area, fallbackText) {
  const haystack = (area ?? fallbackText ?? '').toLowerCase();
  return AREA_KEYWORDS.some((kw) => haystack.includes(kw));
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

      const { validFrom, validTo } = extractValidity(strings);
      const popis = extractPopis(strings);
      if (popis) {
        const parsed = parsePopis(popis);
        if (!matchesArea(parsed.area, popis)) continue;
        reports.push({ area: parsed.area, validFrom, validTo, tempFrom: parsed.tempFrom, tempTo: parsed.tempTo, weather: parsed.weather, roads: parsed.roads, extra: parsed.extra });
      } else {
        // Záznam neodpovídá očekávanému tvaru "popisu" — nezahazujeme ho
        // tiše, jen nemáme jak ho rozparsovat na pole. Filtr na oblast tu
        // musí být nutně hrubší (celý spojený text), ať se takový záznam
        // vůbec nemůže dostat dál bez jakékoli kontroly na okolí Zlonic.
        const joined = strings.join(' — ');
        if (!matchesArea(null, joined)) continue;
        reports.push({ area: null, validFrom, validTo, tempFrom: null, tempTo: null, weather: null, roads: [], extra: [joined] });
      }
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
