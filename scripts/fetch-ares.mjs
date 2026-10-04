// Naplní data/firms.json seznamem aktivních ekonomických subjektů v
// Zlonicích (ARES) pro sekci "O Zlonicích" na stránce. Spouští ho
// .github/workflows/update-firms.yml jednou denně — živnostenský/
// obchodní rejstřík se mění řádově dny až týdny, ne v řádu minut.
//
// PROČ TOHLE EXISTUJE: stránka dřív volala ARES přímo z prohlížeče při
// KAŽDÉ návštěvě — jeden dotaz na seznam + až 9 dalších stránkovaných
// dotazů (100 subjektů/stránka, Zlonice mají přes 900 aktivních
// subjektů), dohromady zhruba 1,5 MB přenesených dat na jedno zobrazení
// webu. Pipeline tohle udělá jednou za den na pozadí a uloží jen tři
// pole na subjekt (czNace2008, datumVzniku, obchodniJmeno), co appka
// skutečně potřebuje pro graf oborů a statistiku nejstarší/nejnovější
// firmy (viz loadAres() v index.html) — zbytek odpovědi ARESu appka
// nikdy nepoužívala.
//
// index.html čte nejdřív tenhle soubor; když chybí nebo je status chybný,
// sám si to (pomaleji, ale funkčně) dotáhne přímo z ARESu jako dřív —
// stejná bezpečnostní zásada jako jinde v repu: žádný nový mechanismus
// appku nesmí rozbít, jen zrychlit běžný případ.
import { writeFileSync } from 'node:fs';

const OUT_PATH = 'data/firms.json';
const KOD_OBCE = 533114; // Zlonice, RÚIAN — stejný kód jako loadAres() v index.html
const ARES_TIMEOUT_MS = 10_000;

async function fetchAresPage(kodObce, start){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ARES_TIMEOUT_MS);
  try{
    const res = await fetch('https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidlo: { kodObce }, pocet: 100, start }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main(){
  const first = await fetchAresPage(KOD_OBCE, 0);
  const total = first.pocetCelkem || 0;
  const remainingStarts = [];
  for (let start = 100; start < Math.min(total, 1000); start += 100) remainingStarts.push(start);
  const rest = await Promise.all(remainingStarts.map(start => fetchAresPage(KOD_OBCE, start)));
  const all = [first, ...rest].flatMap(d => d.ekonomickeSubjekty || []);
  const active = all
    .filter(s => s.seznamRegistraci && s.seznamRegistraci.stavZdrojeRos === 'AKTIVNI')
    .map(s => ({
      czNace2008: s.czNace2008 || null,
      datumVzniku: s.datumVzniku || null,
      obchodniJmeno: s.obchodniJmeno || null,
    }));

  if (active.length === 0) throw new Error('ARES vrátil 0 aktivních subjektů — spíš výpadek než realita, nepřepisuju poslední dobrá data');

  writeFileSync(OUT_PATH, JSON.stringify({
    status: 'ok',
    updated: new Date().toISOString(),
    active,
  }, null, 2) + '\n');

  console.log(`Hotovo: ${active.length} aktivních subjektů uloženo do ${OUT_PATH}.`);
}

main().catch(err => {
  console.error('Chyba při stahování dat z ARESu:', err.message);
  process.exit(1);
});
