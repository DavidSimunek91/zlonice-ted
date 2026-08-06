// Aktualizuje data/alerts.json z ČHMÚ CAP výstrah (opendata.chmi.cz).
// Spouští ho .github/workflows/update-alerts.yml na časovač — appka sama
// žádné volání na ČHMÚ nedělá (nemá CORS hlavičky, prohlížeč by to stejně
// zablokoval), jen čte výsledný JSON.
//
// Tohle jsou bezpečnostní data, takže dvě pravidla, která se neobcházejí:
//   1. Když se cokoli nepovede (síť, formát, parsování), NIKDY nenapsat
//      "beze zvláštních výstrah" jen proto, že jsme nic nenašli — napíšeme
//      explicitní chybový stav a appka to zobrazí jako "nelze ověřit",
//      ne jako "je to v pořádku".
//   2. Appka navíc sama kontroluje, jak staré jsou tahle data (pole
//      `updated`) — když se pipeline sama zasekne (stalo se nám to
//      u GitHub Pages, může se to stát i tady), appka po chvíli přestane
//      důvěřovat starým datům a ukáže "nelze ověřit", ne poslední známý
//      (možná už neplatný) stav.

import { writeFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const OUT_PATH = 'data/alerts.json';
const CAP_DIR = 'https://opendata.chmi.cz/meteorology/weather/alerts/cap/';

// Zlonice spadá pod ORP Slaný (ne ORP Kladno — to je jiná obec s rozšířenou
// působností ve stejném okrese). Ověřeno: ČSÚ "2124 - SO ORP Slaný" a přímo
// v CAP datech, kde areaDesc s kódem CISORP 2124 vždy obsahuje "Slaný".
const CISORP_ZLONICE = '2124';

// Události, které ČHMÚ vydává jako formální "žádná výstraha" pro danou
// kategorii — tohle NEJSOU aktivní výstrahy, i když mají vlastní <info> blok.
const NO_WARNING_PREFIXES = ['Žádná výstraha', 'Žádný výhled', 'Výhled jevů'];

function isRealWarning(event) {
  return !NO_WARNING_PREFIXES.some(p => event.startsWith(p));
}

async function findLatestCapFile() {
  const res = await fetch(CAP_DIR);
  if (!res.ok) throw new Error(`Nepodařilo se načíst seznam souborů (HTTP ${res.status})`);
  const html = await res.text();

  // Řádky vypadají jako:
  // <a href="alert_cap_50_060914.xml">alert_cap_50_060914.xml</a>   06-Aug-2026 09:15   1234
  const rows = [...html.matchAll(/<a href="([^"]+\.xml)">.*?<\/a>\s+(\d{2}-\w{3}-\d{4} \d{2}:\d{2})/g)];
  if (rows.length === 0) throw new Error('V adresáři CAP souborů se nenašel žádný .xml soubor');

  let latest = null;
  for (const [, filename, dateStr] of rows) {
    const date = new Date(dateStr.replace(
      /(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2})/,
      (_, d, mon, y, h, min) => `${d} ${mon} ${y} ${h}:${min}`
    ));
    if (!latest || date > latest.date) latest = { filename, date };
  }
  return latest.filename;
}

function areaHasZlonice(area) {
  const geocodes = Array.isArray(area?.geocode) ? area.geocode : (area?.geocode ? [area.geocode] : []);
  return geocodes.some(g => g.valueName === 'CISORP' && String(g.value) === CISORP_ZLONICE);
}

async function main() {
  const filename = await findLatestCapFile();
  const res = await fetch(CAP_DIR + filename);
  if (!res.ok) throw new Error(`Nepodařilo se stáhnout ${filename} (HTTP ${res.status})`);
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => ['info', 'area', 'geocode'].includes(name),
  });
  const doc = parser.parse(xml);
  const alert = doc.alert;
  if (!alert || !alert.info) throw new Error('CAP soubor nemá očekávanou strukturu (chybí <alert><info>)');

  const infos = Array.isArray(alert.info) ? alert.info : [alert.info];
  const relevant = infos.filter(info => {
    if (info.language !== 'cs') return false;
    const areas = Array.isArray(info.area) ? info.area : (info.area ? [info.area] : []);
    return areas.some(areaHasZlonice);
  });

  const now = new Date();
  const active = relevant.filter(info => {
    if (!isRealWarning(String(info.event || ''))) return false;
    const start = info.effective || info.onset || alert.sent;
    if (!start) return false;
    if (new Date(start) > now) return false; // ještě nezačalo platit
    if (info.expires && new Date(info.expires) < now) return false; // už vypršelo
    return true;
  }).map(info => ({
    event: info.event,
    severity: info.severity,       // Extreme | Severe | Moderate | Minor | Unknown
    urgency: info.urgency,
    certainty: info.certainty,
    headline: info.headline || null,
    onset: info.onset || null,
    expires: info.expires || null,
    web: info.web || 'https://vystrahy-cr.chmi.cz/',
  }));

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    sourceFile: filename,
    hasActive: active.length > 0,
    alerts: active,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Hotovo: ${active.length} aktivních výstrah pro ORP Slaný (Zlonice), zdroj ${filename}.`);
}

main().catch(err => {
  console.error('Aktualizace výstrah selhala:', err);
  const output = {
    status: 'error',
    updated: new Date().toISOString(),
    message: String(err.message || err),
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  // Chybový stav se má commitnout (appka podle něj ukáže "nelze ověřit"),
  // takže tady process neukončujeme s chybovým kódem.
});
