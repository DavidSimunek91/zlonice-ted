// Aktualizuje data/water.json z živých ČHMÚ hydrologických dat — stanice
// Velvary, tok Bakovský potok (16 km od Zlonic, nejbližší reálná stanice).
// Nahrazuje dřívější ručně vkládaný snímek: ČHMÚ tahle data aktualizuje
// každých 10 minut, takže "ruční snímek jednou za čas" nikdy nebyl
// dostatečně čerstvý na to, aby dával smysl v appce jménem "Ve Zlonicích".
//
// opendata.chmi.cz nemá CORS hlavičky (stejně jako u výstrah), takže appka
// sama volat nemůže — tenhle skript běží na pozadí, appka čte jen výsledný
// malý JSON.

import { writeFileSync } from 'node:fs';

const OUT_PATH = 'data/water.json';
const META_URL = 'https://opendata.chmi.cz/hydrology/now/metadata/meta1.json';
const STATION_NAME = 'Velvary';

async function main(){
  // 1) Metadata (prahové hodnoty sucha/povodňové aktivity) — čteme je
  // živě z ČHMÚ při každém běhu, ne natvrdo v kódu, kdyby je ČHMÚ někdy
  // upravil.
  const metaRes = await fetch(META_URL);
  if (!metaRes.ok) throw new Error(`Nepodařilo se načíst metadata stanic (HTTP ${metaRes.status})`);
  const meta = await metaRes.json();
  const table = meta.data.data;
  const header = table.header.split(',');
  const nameIdx = header.indexOf('STATION_NAME');
  const row = table.values.find(v => v[nameIdx] === STATION_NAME);
  if (!row) throw new Error(`Stanice "${STATION_NAME}" se v metadatech ČHMÚ nenašla`);
  const meta_ = Object.fromEntries(header.map((h, i) => [h, row[i]]));

  const objId = meta_.objID;

  // 2) Živá data stanice — vodní stav (H), průtok (Q), teplota vody (TH).
  const dataRes = await fetch(`https://opendata.chmi.cz/hydrology/now/data/${objId}.json`);
  if (!dataRes.ok) throw new Error(`Nepodařilo se načíst data stanice ${objId} (HTTP ${dataRes.status})`);
  const data = await dataRes.json();
  const obj = data.objList?.[0];
  if (!obj) throw new Error('Neočekávaná struktura dat stanice — chybí objList[0]');

  function latest(tsConID){
    const ts = obj.tsList.find(t => t.tsConID === tsConID);
    if (!ts || !ts.tsData?.length) return null;
    const last = ts.tsData[ts.tsData.length - 1];
    return { value: last.value, unit: ts.unit, observedAt: last.dt };
  }

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    station: STATION_NAME,
    stream: meta_.STREAM_NAME,
    thresholds: {
      dry: meta_.DRYH,
      spa1: meta_.SPA1H,
      spa2: meta_.SPA2H,
      spa3: meta_.SPA3H,
    },
    // Stejné stupně sucha/povodňové aktivity, ale v jednotkách průtoku
    // (m³/s) — ČHMÚ je pro tuhle stanici vede paralelně k těm výškovým,
    // takže i "Průtok" v appce může mít vlastní interpretaci (dřív měl
    // jen holé číslo bez kontextu).
    thresholdsFlow: {
      dry: Number(meta_.DRYQ),
      spa1: Number(meta_.SPA1Q),
      spa2: Number(meta_.SPA2Q),
      spa3: Number(meta_.SPA3Q),
    },
    level: latest('H'),
    flow: latest('Q'),
    temperature: latest('TH'),
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log('Hotovo:', JSON.stringify(output));
}

main().catch(err => {
  console.error('Aktualizace dat o vodě selhala:', err);
  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
