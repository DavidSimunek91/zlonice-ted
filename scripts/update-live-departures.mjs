// Aktualizuje data/live-departures.json — živé zpoždění spojů na
// zastávkách kolem Zlonic z Golemio API (Pražská datová platforma, pod
// kterou spadá i PID). Doplňuje scripts/update-departures.mjs, který dělá
// jen samotný jízdní řád (jednou denně) — tenhle skript běží mnohem
// častěji a nese jen to, co se denně nezmění: aktuální zpoždění, zda je
// spoj zrušený, jestli je vůz fyzicky na zastávce.
//
// Golemio API vyžaduje API klíč (hlavička X-Access-Token) — klíč nejde
// dát do klientského JS appky (byl by veřejně vidět), takže stejně jako
// u ŘSD/NDIC běží volání jen tady, na pozadí, s klíčem jako GitHub
// Actions secret GOLEMIO_API_KEY.
//
// Registrace je na rozdíl od ŘSD/NDIC samoobslužná a okamžitá (jen
// e-mailové ověření): https://api.golemio.cz/api-keys
//
// Dokud secret není nastavený, skript nic nevolá a zapíše
// status: "pending_access" — appka pak zpoždění prostě nezobrazuje a
// jízdní řád funguje dál jako dřív, beze změny.

import { readFileSync, writeFileSync } from 'node:fs';

const OUT_PATH = 'data/live-departures.json';
const DEPARTURES_PATH = 'data/departures.json';
const API_KEY = process.env.GOLEMIO_API_KEY;
const ROUTE_SHORT_NAMES = ['590', '591', '594'];

async function main(){
  if (!API_KEY){
    const output = {
      status: 'pending_access',
      updated: new Date().toISOString(),
      message: 'GOLEMIO_API_KEY není nastavený — registrace na api.golemio.cz/api-keys, pak repo secret.',
    };
    writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log('GOLEMIO_API_KEY chybí, nic nevolám.');
    return;
  }

  // Zastávkové ID bereme z výstupu denní GTFS pipeline, ne z vlastního
  // stahování celého zipu — ten už je jednou denně vyfiltrovaný přesně
  // na zastávky kolem Zlonic.
  const departures = JSON.parse(readFileSync(DEPARTURES_PATH, 'utf-8'));
  if (departures.status !== 'ok' || !departures.stopIds){
    throw new Error('data/departures.json ještě neobsahuje stopIds — počkej na příští běh denní GTFS pipeline.');
  }
  const stopIds = [...new Set(Object.values(departures.stopIds).flat())];
  if (stopIds.length === 0) throw new Error('V data/departures.json nejsou žádné stopIds pro zastávky Zlonice');

  const params = new URLSearchParams();
  stopIds.forEach(id => params.append('ids[]', id));
  params.set('minutesAfter', '360'); // pokrývá i nejhorší případ, kdy je 6 nejbližších spojů rozprostřeno přes několik hodin
  params.set('limit', '200');
  params.set('order', 'timetable'); // stabilní pořadí, appka si stejně páruje podle tripId

  const url = `https://api.golemio.cz/v2/pid/departureboards?${params.toString()}`;
  const res = await fetch(url, { headers: { 'X-Access-Token': API_KEY } });
  if (!res.ok) throw new Error(`Golemio API vrátilo HTTP ${res.status}`);
  const data = await res.json();

  const byTrip = {};
  for (const dep of data.departures || []){
    const route = dep.route?.short_name;
    if (!ROUTE_SHORT_NAMES.includes(route)) continue;
    const tripId = dep.trip?.id;
    if (!tripId) continue;
    byTrip[tripId] = {
      isCanceled: !!dep.trip?.is_canceled,
      isAtStop: !!dep.trip?.is_at_stop,
      delayAvailable: !!dep.delay?.is_available,
      delayMinutes: dep.delay?.minutes ?? null,
      delaySeconds: dep.delay?.seconds ?? null,
      scheduled: dep.departure_timestamp?.scheduled ?? null,
      predicted: dep.departure_timestamp?.predicted ?? null,
    };
  }

  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    byTrip,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
  console.log(`Hotovo: živé zpoždění pro ${Object.keys(byTrip).length} spojů (z ${stopIds.length} zastávkových ID).`);
}

main().catch(err => {
  console.error('Aktualizace živého zpoždění selhala:', err);
  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
