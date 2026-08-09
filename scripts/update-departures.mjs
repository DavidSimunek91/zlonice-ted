// Aktualizuje data/departures.json z PID GTFS statických dat (jízdní řády).
// Kromě samotného jízdního řádu ukládá i stop_id a trip_id jednotlivých
// spojů — díky tomu si scripts/update-live-departures.mjs (živé zpoždění
// z Golemio API, běží mnohem častěji) nemusí sám znovu stahovat a
// prohledávat celý 46MB GTFS zip, jen si přečte tenhle už vyfiltrovaný
// JSON a ptá se Golemia jen na ID zastávek, co nás zajímají.
//
// PID_GTFS.zip nemá CORS hlavičky, takže appka sama nemůže volat přímo —
// tenhle skript běží na pozadí (GitHub Actions), stáhne ~46 MB zip, vyfiltruje
// jen linky a zastávky kolem Zlonic, a uloží malý JSON, který appka čte.
//
// Appka pak sama z tohohle JSONu spočítá "další odjezdy" podle aktuálního
// data a dne v týdnu — pipeline běží jednou denně (GTFS se stejně generuje
// jen jednou denně u PID), počítání "za kolik minut" dělá klient napořád
// z aktuálního jízdního řádu, ne z předpočítaného zastaralého seznamu.

import { writeFileSync, mkdtempSync, createReadStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const OUT_PATH = 'data/departures.json';
const GTFS_URL = 'https://data.pid.cz/PID_GTFS.zip';
const ROUTE_SHORT_NAMES = ['590', '591', '594']; // linky obsluhující Zlonice

function parseCsvSync(text){
  // Pro menší soubory (routes/trips/stops/calendar*) — načíst celé do paměti.
  const records = [];
  const rows = text.split('\n').filter(l => l.length > 0);
  // Jednoduché parsování s podporou uvozovek (GTFS pole s čárkou uvnitř).
  const header = splitCsvLine(rows[0]);
  for (let i = 1; i < rows.length; i++){
    const cols = splitCsvLine(rows[i]);
    if (cols.length !== header.length) continue;
    const obj = {};
    header.forEach((h, idx) => obj[h] = cols[idx]);
    records.push(obj);
  }
  return records;
}

function splitCsvLine(line){
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++){
    const ch = line[i];
    if (ch === '"'){ inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes){ out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.replace(/\r$/, ''));
  return out;
}

async function main(){
  const workDir = mkdtempSync(join(tmpdir(), 'pid-gtfs-'));
  try{
    console.log('Stahuji PID_GTFS.zip…');
    const res = await fetch(GTFS_URL);
    if (!res.ok) throw new Error(`Nepodařilo se stáhnout GTFS (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zipPath = join(workDir, 'PID_GTFS.zip');
    writeFileSync(zipPath, buf);

    console.log('Rozbaluji potřebné soubory…');
    const needed = ['routes.txt', 'trips.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt', 'stop_times.txt'];
    execFileSync('unzip', ['-o', '-q', zipPath, ...needed, '-d', workDir]);

    const routes = parseCsvSync(await readFile(join(workDir, 'routes.txt')));
    const relevantRouteIds = new Map(); // route_id -> short_name
    for (const r of routes){
      if (ROUTE_SHORT_NAMES.includes(r.route_short_name)) relevantRouteIds.set(r.route_id, r.route_short_name);
    }
    console.log('Nalezené linky:', [...relevantRouteIds.entries()]);
    if (relevantRouteIds.size === 0) throw new Error('V routes.txt se nenašla žádná z linek ' + ROUTE_SHORT_NAMES.join(', '));

    const stops = parseCsvSync(await readFile(join(workDir, 'stops.txt')));
    const stopIdToName = new Map();
    const stopIdsByName = {}; // stopName -> [stop_id, …] — jedno jméno může mít víc fyzických stop_id (různé nástupiště/směry)
    for (const s of stops){
      if (s.stop_name && s.stop_name.startsWith('Zlonice')){
        stopIdToName.set(s.stop_id, s.stop_name);
        (stopIdsByName[s.stop_name] ||= []).push(s.stop_id);
      }
    }
    console.log('Nalezené zastávky:', [...new Set(stopIdToName.values())]);
    if (stopIdToName.size === 0) throw new Error('Ve stops.txt se nenašla žádná zastávka "Zlonice*"');

    const trips = parseCsvSync(await readFile(join(workDir, 'trips.txt')));
    const relevantTripIds = new Map(); // trip_id -> {routeShortName, serviceId, headsign}
    for (const t of trips){
      if (relevantRouteIds.has(t.route_id)){
        relevantTripIds.set(t.trip_id, {
          route: relevantRouteIds.get(t.route_id),
          serviceId: t.service_id,
          headsign: t.trip_headsign || '',
        });
      }
    }
    console.log('Relevantních spojů (trips):', relevantTripIds.size);

    // stop_times.txt je ~114 MB — čte se řádek po řádku, ne najednou do paměti.
    console.log('Procházím stop_times.txt (streamovaně)…');
    const departuresByStop = {}; // stopName -> [{time, route, headsign, serviceId}]
    const usedServiceIds = new Set();

    const rl = createInterface({ input: createReadStream(join(workDir, 'stop_times.txt')) });
    let header = null;
    let idx = null;
    for await (const line of rl){
      if (!header){
        header = splitCsvLine(line);
        idx = {
          trip_id: header.indexOf('trip_id'),
          departure_time: header.indexOf('departure_time'),
          stop_id: header.indexOf('stop_id'),
        };
        continue;
      }
      if (!line) continue;
      // Rychlá předběžná kontrola bez plného parsování řádku (výkon):
      // stop_id nás zajímá jen když je v naší množině.
      const cols = splitCsvLine(line);
      const stopId = cols[idx.stop_id];
      const stopName = stopIdToName.get(stopId);
      if (!stopName) continue;
      const tripId = cols[idx.trip_id];
      const trip = relevantTripIds.get(tripId);
      if (!trip) continue;

      (departuresByStop[stopName] ||= []).push({
        time: cols[idx.departure_time],
        route: trip.route,
        headsign: trip.headsign,
        serviceId: trip.serviceId,
        tripId,
      });
      usedServiceIds.add(trip.serviceId);
    }

    for (const name of Object.keys(departuresByStop)){
      departuresByStop[name].sort((a, b) => a.time.localeCompare(b.time));
    }
    console.log('Zastávky s odjezdy:', Object.keys(departuresByStop));

    const calendar = parseCsvSync(await readFile(join(workDir, 'calendar.txt')));
    const services = {};
    for (const c of calendar){
      if (!usedServiceIds.has(c.service_id)) continue;
      services[c.service_id] = {
        days: [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].map(v => v === '1'),
        start: c.start_date,
        end: c.end_date,
        exceptions: {},
      };
    }

    const calendarDates = parseCsvSync(await readFile(join(workDir, 'calendar_dates.txt')));
    for (const cd of calendarDates){
      if (!services[cd.service_id]) continue;
      services[cd.service_id].exceptions[cd.date] = Number(cd.exception_type); // 1 = přidáno, 2 = zrušeno
    }

    const output = {
      status: 'ok',
      updated: new Date().toISOString(),
      routes: ROUTE_SHORT_NAMES,
      stops: departuresByStop,
      stopIds: stopIdsByName,
      services,
    };
    writeFileSync(OUT_PATH, JSON.stringify(output) + '\n');
    console.log(`Hotovo: ${Object.keys(departuresByStop).length} zastávek, ${Object.keys(services).length} service_id záznamů.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function readFile(path){
  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf-8');
}

main().catch(err => {
  console.error('Aktualizace jízdních řádů selhala:', err);
  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
