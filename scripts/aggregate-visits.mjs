// Shrne syrový log návštěv (infra/visit-log/beacon-server.mjs) do
// data/stats.json, který appka čte na /stats.html — a při každém běhu
// zahodí ze souboru všechno starší než 7 dní (VISIT_WINDOW_DAYS). Tohle
// je jediné místo, kde se syrové IP adresy z logu mažou — proto musí
// běžet pravidelně (viz infra/visit-log/README.md), jinak by log rostl
// bez omezení.
//
// Běží jen na droplu (infra/do-pipelines), ne v GitHub Actions — log je
// soubor na disku droplu, GitHub Actions runner by na něj neviděl.
//
// "Unikátní návštěvy" = počet různých IP adres v okně. "Opakované" =
// kolik z nich se objevilo aspoň ve 2 různých dnech okna (ne jen 2x na
// jednu stránku téhož dne — jeden člověk, co si obnoví stránku 5x za
// minutu, by jinak vypadal jako "opakovaný návštěvník").
//
// Známé zjednodušení: čtení+přepis logu není atomické vůči souběžnému
// zápisu z beacon-server.mjs — návštěva zapsaná přesně v tu chvíli,
// kdy tenhle skript logfile přepisuje, se může ztratit. U počítadla pro
// malý komunitní web je to přijatelný kompromis za jednodušší kód.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOG_PATH = process.env.VISIT_LOG_PATH || `${process.env.HOME}/vezlonicich-visits.ndjson`;
const OUT_PATH = 'data/stats.json';
const VISIT_WINDOW_DAYS = 7;

function main(){
  const windowMs = VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - windowMs;

  let lines = [];
  if (existsSync(LOG_PATH)){
    lines = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  }

  const hits = [];
  for (const line of lines){
    try {
      const rec = JSON.parse(line);
      const t = new Date(rec.ts).getTime();
      if (Number.isFinite(t) && t >= cutoff && rec.ip) hits.push({ ip: rec.ip, t });
    } catch {
      // Poškozený/nedokončený řádek (např. zápis přerušený uprostřed) —
      // přeskočit, ne shodit celý běh kvůli jednomu řádku.
    }
  }

  // Přepsat log jen tím, co je v okně — odtud plyne "7denní rotace".
  writeFileSync(LOG_PATH, hits.map(h => JSON.stringify({ ip: h.ip, ts: new Date(h.t).toISOString() })).join('\n') + (hits.length ? '\n' : ''));

  const dayKey = (t) => new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  const daysByIp = new Map(); // ip -> Set(dayKey)
  const dailyHits = new Map(); // dayKey -> count
  const dailyIps = new Map(); // dayKey -> Set(ip)

  for (const h of hits){
    const day = dayKey(h.t);
    if (!daysByIp.has(h.ip)) daysByIp.set(h.ip, new Set());
    daysByIp.get(h.ip).add(day);
    dailyHits.set(day, (dailyHits.get(day) || 0) + 1);
    if (!dailyIps.has(day)) dailyIps.set(day, new Set());
    dailyIps.get(day).add(h.ip);
  }

  const uniqueVisitors = daysByIp.size;
  const repeatVisitors = [...daysByIp.values()].filter(days => days.size >= 2).length;

  // Posledních VISIT_WINDOW_DAYS dnů, i ty bez jediné návštěvy (0, ne
  // chybějící řádek) — tabulka na /stats.html tak má vždy stejný počet
  // řádků, ne "díry" tam, kde nikdo nezavítal.
  const daily = [];
  for (let i = VISIT_WINDOW_DAYS - 1; i >= 0; i--){
    const day = dayKey(now - i * 24 * 60 * 60 * 1000);
    daily.push({
      date: day,
      hits: dailyHits.get(day) || 0,
      unique: dailyIps.get(day)?.size || 0,
    });
  }

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    windowDays: VISIT_WINDOW_DAYS,
    totalHits: hits.length,
    uniqueVisitors,
    repeatVisitors,
    daily,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log(`Hotovo: ${hits.length} návštěv v okně, ${uniqueVisitors} unikátních, ${repeatVisitors} opakovaných.`);
}

main();
