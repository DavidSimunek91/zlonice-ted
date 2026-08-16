// Aktualizuje data/tradespeople.json — seznam řemeslníků a živnostníků v
// Zlonicích podle oboru (elektrikář, zedník, instalatér, švadlena...),
// pro sekci "Řemeslníci a služby" na appce. Spouští ho
// .github/workflows/update-tradespeople.yml na týdenní časovač — živnostenský
// rejstřík se mění zřídka, není důvod tahat stovky detailních dotazů častěji.
//
// ZDROJE (kombinace dvou, viz README pro rozbor proč):
//   1. ARES / Živnostenský rejstřík (RŽP), ares.gov.cz — veřejný registr,
//      bez klíče, CORS povolený i pro appku (viz loadAres() v index.html).
//      Dává jméno, obor (predmetPodnikani), adresu místa podnikání a datum
//      vzniku živnosti. NEDÁVÁ telefon ani e-mail — ŽRP tohle neeviduje.
//      Pipeline běží místo appky samotné, protože jeden běh znamená
//      1 dotaz na seznam + samostatný dotaz na KAŽDÉHO aktivního živnostníka
//      (v Zlonicích ~260), což by na klientovi bylo pomalé a zbytečně časté
//      při každém načtení stránky pro data, co se mění řádově měsíčně.
//   2. OpenStreetMap (Overpass API) — DOPLNĚK, ne náhrada. Pokrytí je
//      nahodilé (jen kdo se sám zapsal do OSM/Mapy.cz), ale když se najde
//      shoda jména+oboru s ARES záznamem, přidá se telefon/web. Nikdy
//      nepřidává nové lidi, jen obohacuje kontakt u někoho, koho už máme
//      z ARESu — takže špatná shoda může nanejvýš chybět, ne ukázat
//      špatný telefon u někoho jiného (viz matchOsm níž, vyžaduje shodu
//      jména I oboru).
//
// ROZSAH (v1): jen samotné Zlonice (a jejich místní části — Břešťany atd.),
// ne okolní obce. Bylo by snadné přidat víc obcí (kódObce je v ARES dotazu
// parametr), ale úmyslně zatím ne — viz data/README.md.
//
// Bezpečnostní pravidla, stejná jako u ostatních zdrojů v tomhle repu:
//   1. Když selže ARES seznam subjektů úplně, nebo se podaří načíst míň než
//      70 % detailů aktivních živnostníků → traktujeme to jako chybu běhu
//      (viz main().catch()) a NEpřepisujeme poslední DOBRÁ data.
//   2. Jednotlivé neúspěšné detailní dotazy (typicky pár timeoutů z stovek)
//      naopak běh nezastaví — ten člověk se v tomhle běhu prostě vynechá,
//      příští týden to zkusí znovu. Loguje se kolik.
//   3. Overpass/OSM je čistě bonus — když selže celé, pipeline pokračuje
//      bez obohacení kontaktů, ne že by shodila celý běh.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const OUT_PATH = 'data/tradespeople.json';
const KOD_OBCE = 533114; // Zlonice, RÚIAN — stejný kód jako v index.html loadAres()
const ARES_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';
const ARES_TIMEOUT_MS = 10_000;
const DETAIL_CONCURRENCY = 6;
const MIN_SUCCESS_RATIO = 0.7; // pod touhle hranicí = spíš výpadek ARESu než pár smolných timeoutů

// Zlonice, souřadnice shodné s index.html — enrichment z OSM se drží těsně
// kolem samotné obce (viz komentář nahoře k rozsahu v1).
const ZLONICE_LAT = 50.2875;
const ZLONICE_LON = 14.0922;
const OSM_RADIUS_M = 5000;
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// Mapování přesného textu `predmetPodnikani` z živnostenského rejstříku na
// kategorii, kterou appka ukazuje. Klíče jsou normalizované (viz
// normalizeWhitespace) — ARES v datech občas má zdvojené mezery. Jen tenhle
// seznam rozhoduje, kdo je "řemeslník" pro účely týhle sekce — živnosti mimo
// mapu (typicky obecná volná živnost "Výroba, obchod a služby neuvedené v
// přílohách...") se ignorují, ať appka neukazuje kdejakého e-shopáře jako
// řemeslníka.
const CATEGORIES = {
  zednik: { label: 'Zedník', group: 'Stavba a dům', icon: '🧱' },
  truhlar: { label: 'Truhlář, podlahář', group: 'Stavba a dům', icon: '🪚' },
  pokryvac: { label: 'Pokrývač, tesař', group: 'Stavba a dům', icon: '🏚️' },
  klempir: { label: 'Klempíř, karosář', group: 'Stavba a dům', icon: '🔧' },
  malir: { label: 'Malíř, lakýrník', group: 'Stavba a dům', icon: '🖌️' },
  zamecnik: { label: 'Zámečník, nástrojář', group: 'Stavba a dům', icon: '🔩' },
  kominik: { label: 'Kominík', group: 'Stavba a dům', icon: '🧹' },
  instalater: { label: 'Instalatér, topenář', group: 'Stavba a dům', icon: '🚰' },
  plynar: { label: 'Plynař', group: 'Stavba a dům', icon: '🔥' },
  elektrikar: { label: 'Elektrikář', group: 'Stavba a dům', icon: '💡' },
  stavebni: { label: 'Stavební firma', group: 'Stavba a dům', icon: '🏗️' },
  projektant: { label: 'Projektant', group: 'Stavba a dům', icon: '📐' },
  kovar: { label: 'Kovář, podkovář', group: 'Stavba a dům', icon: '🔨' },
  svadlena: { label: 'Švadlena, krejčí', group: 'Stavba a dům', icon: '🧵' },
  pekar: { label: 'Pekař, cukrář', group: 'Jídlo', icon: '🍞' },
  reznik: { label: 'Řezník, uzenář', group: 'Jídlo', icon: '🥩' },
  automechanik: { label: 'Automechanik', group: 'Auto a technika', icon: '🚗' },
  strojni: { label: 'Opravy strojů a techniky', group: 'Auto a technika', icon: '⚙️' },
  elektroopravy: { label: 'Opravy elektrospotřebičů', group: 'Auto a technika', icon: '🔌' },
  kadernik: { label: 'Kadeřník, holič', group: 'Osobní péče', icon: '✂️' },
  kosmetika: { label: 'Kosmetika', group: 'Osobní péče', icon: '💆' },
  pedikura: { label: 'Pedikúra, manikúra', group: 'Osobní péče', icon: '💅' },
};

const PREDMET_TO_CATEGORY = {
  'Zednictví': 'zednik',
  'Truhlářství, podlahářství': 'truhlar',
  'Pokrývačství, tesařství': 'pokryvac',
  'Klempířství a oprava karoserií': 'klempir',
  'Malířství, lakýrnictví, natěračství': 'malir',
  'Malířství a natěračství': 'malir',
  'Zámečnictví, nástrojářství': 'zamecnik',
  'Kominictví': 'kominik',
  'Vodoinstalatérství, topenářství': 'instalater',
  'Vodoinstalatérství': 'instalater',
  'Topenářství': 'instalater',
  'Montáž, opravy, revize a zkoušky elektrických zařízení': 'elektrikar',
  'Montáž, opravy, revize a zkoušky plynových zařízení a plnění nádob plyny': 'plynar',
  'Provádění staveb, jejich změn a odstraňování': 'stavebni',
  'Projektová činnost ve výstavbě': 'projektant',
  'Kovářství, podkovářství': 'kovar',
  'Výroba, opravy a údržba oděvů, oděvních doplňků, obuvi, brašnářského a sedlářského zboží': 'svadlena',
  'Pekařství, cukrářství': 'pekar',
  'Opravy silničních vozidel': 'automechanik',
  'Opravy ostatních dopravních prostředků a pracovních strojů': 'strojni',
  'Výroba, instalace, opravy elektrických strojů a přístrojů, elektronických a telekomunikačních zařízení':
    'elektroopravy',
  'Holičství, kadeřnictví': 'kadernik',
  'Kosmetické služby': 'kosmetika',
  'Pedikúra, manikúra': 'pedikura',
  'Pedikúra': 'pedikura',
  'Manikúra': 'pedikura',
};

// OSM tagy (craft=* / shop=*) namapované na stejné kategorie jako výš —
// enrichment smí přidat kontakt jen tomu, komu sedí i obor, ne jen jméno
// (viz matchOsm).
const OSM_TAG_TO_CATEGORY = {
  electrician: 'elektrikar',
  plumber: 'instalater',
  hvac: 'instalater',
  carpenter: 'truhlar',
  joiner: 'truhlar',
  painter: 'malir',
  roofer: 'pokryvac',
  metal_construction: 'zamecnik',
  locksmith: 'zamecnik',
  blacksmith: 'kovar',
  dressmaker: 'svadlena',
  tailor: 'svadlena',
  bakery: 'pekar',
  confectionery: 'pekar',
  pastry: 'pekar',
  car_repair: 'automechanik',
  electronics_repair: 'elektroopravy',
  hairdresser: 'kadernik',
  beautician: 'kosmetika',
  beauty: 'kosmetika',
  butcher: 'reznik',
};

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diakritika pryč (kombinující znaky po NFD rozkladu)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} pro ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAresSearchPage(start) {
  return fetchJsonWithTimeout(
    `${ARES_BASE}/ekonomicke-subjekty/vyhledat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidlo: { kodObce: KOD_OBCE }, pocet: 100, start }),
    },
    ARES_TIMEOUT_MS
  );
}

async function fetchAllActiveRzpIcos() {
  const first = await fetchAresSearchPage(0);
  const total = first.pocetCelkem || 0;
  const starts = [];
  for (let start = 100; start < total; start += 100) starts.push(start);
  const rest = await Promise.all(starts.map(fetchAresSearchPage));
  const all = [first, ...rest].flatMap((d) => d.ekonomickeSubjekty || []);
  return all
    .filter(
      (s) =>
        s.seznamRegistraci?.stavZdrojeRos === 'AKTIVNI' && s.seznamRegistraci?.stavZdrojeRzp === 'AKTIVNI'
    )
    .map((s) => s.ico);
}

// Detail jednoho živnostníka z RŽP (přes ARES) — jeden dotaz = jeden pokus,
// bez retry: při stovkách dotazů je jednodušší a bezpečnější pár neúspěchů
// prostě vynechat (viz MIN_SUCCESS_RATIO výš), než pipeline zpomalovat retry
// smyčkou na každém z nich.
async function fetchRzpDetail(ico) {
  try {
    return await fetchJsonWithTimeout(`${ARES_BASE}/ekonomicke-subjekty-rzp/${ico}`, {}, ARES_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Z jednoho RŽP záznamu vytáhne aktivní řemeslné/vázané živnosti, které
// jsou v CATEGORIES mapě — ostatní (typicky obecná volná živnost) se
// ignorují. Vrátí null, když člověk nemá žádnou relevantní živnost.
function extractCraftPerson(rzpData) {
  if (!rzpData?.zaznamy?.length) return null;
  const z = rzpData.zaznamy[0];

  const categoryIds = new Set();
  let earliestSince = null;
  for (const ziv of z.zivnosti || []) {
    if (ziv.datumZaniku) continue; // jen aktivní živnosti
    const predmet = normalizeWhitespace(ziv.predmetPodnikani);
    const catId = PREDMET_TO_CATEGORY[predmet];
    if (!catId) continue;
    categoryIds.add(catId);
    const since = ziv.datumVzniku;
    if (since && (!earliestSince || since < earliestSince)) earliestSince = since;
  }
  if (categoryIds.size === 0) return null;

  const addr =
    (z.adresySubjektu || []).find((a) => a.typAdresy === 'MISTOPODNIKANI') || (z.adresySubjektu || [])[0];

  return {
    name: z.obchodniJmeno || null,
    ico: z.ico,
    categories: [...categoryIds],
    village: addr?.nazevCastiObce || addr?.nazevObce || null,
    address: addr?.textovaAdresa || null,
    since: earliestSince ? earliestSince.slice(0, 4) : null,
    phone: null,
    website: null,
  };
}

async function fetchOsmCandidates() {
  const query = `[out:json][timeout:25];(nwr(around:${OSM_RADIUS_M},${ZLONICE_LAT},${ZLONICE_LON})[craft];nwr(around:${OSM_RADIUS_M},${ZLONICE_LAT},${ZLONICE_LON})[shop~"^(hairdresser|electronics|beauty)$"];);out center tags;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass bez smysluplného User-Agentu rovnou vrací 429 (ověřeno) —
          // veřejná politika Overpassu to výslovně žádá, ať je vidět kdo/proč volá.
          'User-Agent': 've-zlonicich.cz řemeslníci (komunitní web, https://github.com/davidsimunek91/zlonice-ted)',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      return data.elements || [];
    } catch {
      // zkus další zrcadlo, jinak se vrátí prázdné pole níž
    }
  }
  console.warn('Overpass/OSM se nepodařilo dotázat na žádném zrcadle — pokračuju bez obohacení kontaktů.');
  return [];
}

// Obohatí telefonem/webem jen tam, kde je shoda JEDNOZNAČNÁ — jméno (aspoň
// jedno dost dlouhé slovo, ať se netrefí náhodou na "a"/"na") A obor
// zároveň. Jinak radši žádný kontakt než špatný kontakt u cizího jména.
function matchOsm(people, osmElements) {
  const usedOsmIndexes = new Set();
  let matchedCount = 0;

  for (const person of people) {
    const nameWords = normalizeForMatch(person.name)
      .split(' ')
      .filter((w) => w.length >= 4);
    if (nameWords.length === 0) continue;

    const candidates = [];
    osmElements.forEach((el, idx) => {
      if (usedOsmIndexes.has(idx)) return;
      const tags = el.tags || {};
      const tagCategory = OSM_TAG_TO_CATEGORY[tags.craft] || OSM_TAG_TO_CATEGORY[tags.shop];
      if (!tagCategory || !person.categories.includes(tagCategory)) return;
      const haystack = normalizeForMatch([tags.name, tags.operator, tags.brand].filter(Boolean).join(' '));
      if (nameWords.some((w) => haystack.includes(w))) candidates.push(idx);
    });

    if (candidates.length !== 1) continue; // žádná shoda, nebo dvojznačná — radši nic
    const idx = candidates[0];
    usedOsmIndexes.add(idx);
    const tags = osmElements[idx].tags || {};
    person.phone = tags.phone || tags['contact:phone'] || null;
    person.website = tags.website || tags['contact:website'] || null;
    if (person.phone || person.website) matchedCount++;
  }
  return matchedCount;
}

async function main() {
  const icos = await fetchAllActiveRzpIcos();
  if (icos.length === 0) throw new Error('ARES vrátil nula aktivních živnostníků pro Zlonice — podezřelé, spíš chyba než realita.');

  const details = await mapWithConcurrency(icos, DETAIL_CONCURRENCY, fetchRzpDetail);
  const fetchedCount = details.filter(Boolean).length;
  const successRatio = fetchedCount / icos.length;
  if (successRatio < MIN_SUCCESS_RATIO) {
    throw new Error(
      `Jen ${fetchedCount}/${icos.length} (${Math.round(successRatio * 100)} %) detailních dotazů na ARES uspělo — pod prahem ${Math.round(MIN_SUCCESS_RATIO * 100)} %, spíš výpadek než pár smolných timeoutů.`
    );
  }

  const people = details.map(extractCraftPerson).filter(Boolean);
  people.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));

  const osmElements = await fetchOsmCandidates();
  const osmMatchedCount = matchOsm(people, osmElements);

  const usedCategoryIds = new Set(people.flatMap((p) => p.categories));
  const categories = Object.fromEntries(
    Object.entries(CATEGORIES).filter(([id]) => usedCategoryIds.has(id))
  );

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    obec: 'Zlonice',
    sourceCounts: {
      aresSubjectsChecked: icos.length,
      aresSubjectsWithDetail: fetchedCount,
      craftspeople: people.length,
      osmContactsMatched: osmMatchedCount,
    },
    categories,
    people,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log(
    `Hotovo: ${people.length} řemeslníků/živnostníků v ${Object.keys(categories).length} oborech (z ${icos.length} prověřených aktivních živnostníků), ${osmMatchedCount} obohaceno kontaktem z OSM.`
  );
}

main().catch((err) => {
  console.error('Aktualizace seznamu řemeslníků selhala:', err);

  // Stejné pravidlo jako u traffic/water pipeline: živnostenský rejstřík
  // se mění pomalu, poslední DOBRÁ data jsou pořád lepší než chybový stav
  // kvůli jednomu nepovedenému běhu (výpadek ARESu, síť).
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
  process.exitCode = 1;
});
