// Aktualizuje data/traffic.json z živého API ŘSD/NDIC (mobilitydata.rsd.cz,
// DATEX II). Spouští ho .github/workflows/update-traffic.yml na časovač —
// appka sama žádné volání na ŘSD nedělá, jen čte výsledný JSON.
//
// STAV: čekáme na schválení přístupu (registrace + API klíč), viz PR popis.
// Dokud RSD_API_KEY není nastavený jako repo secret, skript se ukončí beze
// změny — data/traffic.json zůstává v "pending_access" stavu a appka
// ukazuje "připravujeme", ne vymyšlená čísla.
//
// Až přijde přístup, doplnit sem:
//   1. skutečnou URL FCD / SituationPublication endpointu
//      (viz https://mobilitydata.rsd.cz/Api/GetDocumentation)
//   2. parsování DATEX II XML odpovědi
//   3. zjednodušení na pár čísel/vět, co appka umí zobrazit stejně jako
//      u ostatních sekcí (žádné syrové XML/DATEX II v repu)

import { writeFileSync } from 'node:fs';

const OUT_PATH = 'data/traffic.json';
const API_KEY = process.env.RSD_API_KEY;

async function main() {
  if (!API_KEY) {
    console.log('RSD_API_KEY není nastavený — přístup od ŘSD zatím nemáme, nic se nemění.');
    return;
  }

  // TODO: nahradit skutečným voláním, jakmile budeme mít API klíč a známe
  // přesný formát endpointu, např.:
  //
  //   const res = await fetch('https://mobilitydata.rsd.cz/api/.../fcd', {
  //     headers: { 'API-Key': API_KEY },
  //   });
  //   const xml = await res.text();
  //   const parsed = parseDatexII(xml); // vlastní/knihovní parser
  //   writeFileSync(OUT_PATH, JSON.stringify({
  //     updated: new Date().toISOString(),
  //     status: 'ok',
  //     ...parsed,
  //   }, null, 2) + '\n');

  console.log('TODO: napojit skutečné ŘSD API, jakmile bude znám přesný formát endpointu.');
}

main().catch(err => {
  console.error('Aktualizace dopravních dat selhala:', err);
  process.exitCode = 1;
});
