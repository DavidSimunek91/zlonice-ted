// Malý transparentní relay pro ŘSD/NDIC (mobilitydata.rsd.cz) — běží na
// domácím počítači (rezidentní IP, ne datacentrum), protože ŘSD blokuje
// cloudové/datacentrové IP rozsahy (potvrzeno: Azure/GitHub Actions,
// DigitalOcean droplet, sdílený fond Cloudflare Workers — viz
// data/README.md a report o stavu dopravní pipeline). Navenek ho
// vystavuje Tailscale (soukromá síť mezi dropletem a tímhle notebookem,
// WireGuard šifrování) — žádná veřejná doména, žádný port forwarding na
// routeru, žádný certifikát k řešení. Proxy poslouchá jen na Tailscale IP
// (`BIND_HOST` níž), zvenku (z veřejného internetu) není vidět vůbec.
//
// Dělá přesně to samé, co existující infra/rsd-relay/relay-server.mjs
// (Oracle Cloud varianta, dnes nedostupná) — jen přeposílá požadavek dál
// na jednu pevně danou adresu a vrátí odpověď 1:1, nic si neukládá ani
// nezpracovává. scripts/update-traffic.mjs se NEMĚNÍ: Basic Auth hlavičku
// (RSD_USERNAME/RSD_PASSWORD) si skládá a posílá sám skript — tenhle
// proxy ji jen beze změny přeposílá dál. Proto proxy vůbec nepotřebuje
// znát přístupové údaje k ŘSD, jen svůj vlastní sdílený token (PROXY_KEY,
// stejné jméno jako u Cloudflare Worker/Oracle relay, ať se skript nemusí
// nijak upravovat). Pozor: ta Basic Auth hlavička tímhle procesem fyzicky
// protéká (je to transparentní relay) — jen se nikde neukládá ani
// neloguje (viz log() níž) a mezi dropletem a notebookem jde přes
// Tailscale šifrovaně, ne přes veřejný internet.
//
// Env proměnné (v .env vedle tohohle souboru, NIKDY v gitu):
//   PROXY_KEY — musí sedět s hodnotou PROXY_KEY v ~/zlonice-ted.env na
//               droplu. Vygeneruj náhodný řetězec (viz README.md). Druhá
//               pojistka navíc k tomu, že Tailscale síť je sama o sobě
//               privátní a zvenku nedosažitelná.
//   BIND_HOST — Tailscale IP tohohle notebooku (např. 100.x.y.z, zjistíš
//               přes `tailscale ip -4`). Výchozí 127.0.0.1 (bezpečný
//               default — dokud se nenastaví, proxy poslouchá jen sama
//               na sebe a droplet se k ní vůbec nedostane).
//   PORT      — port, výchozí 8787.

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ruční, závislostí prostý loader pro .env vedle tohoto souboru — ať
// proxy nepotřebuje `npm install`, jen holý Node.
const ENV_PATH = join(__dirname, '.env');
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = Number(process.env.PORT || 8787);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PROXY_KEY = process.env.PROXY_KEY;
const TARGET_HOST = 'mobilitydata.rsd.cz';
const TARGET_PATH = '/Resources/Dynamic/CommonTIDatex_v2/';
const UPSTREAM_TIMEOUT_MS = 20_000;
const LOG_PATH = join(__dirname, 'proxy.log');

if (!PROXY_KEY) {
  console.error('PROXY_KEY není nastavený (.env vedle server.mjs), končím.');
  process.exit(1);
}

// Log nikdy neobsahuje hodnotu PROXY_KEY ani Authorization hlavičky —
// jen metodu/stav/čas, ať je bezpečné ho číst nebo poslat dál.
function log(line) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Log je jen pro ladění — pád na zápisu logu nemá shazovat samotný proxy.
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // Jediná pojistka proti zneužití jako veřejnou otevřenou proxy. Token
  // sám o sobě nenese žádné tajemství o ŘSD, jen řeší přístup k tomuhle
  // relayi.
  if (req.headers['x-proxy-key'] !== PROXY_KEY) {
    log(`401 ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
    return;
  }

  // Cílová cesta je napevno daná (allowlist) — ignoruje se, s jakou cestou
  // nebo parametry požadavek skutečně přišel. Nejde to použít jako obecnou
  // proxy na cokoli jiného.
  const upstreamReq = httpsRequest(
    {
      hostname: TARGET_HOST,
      path: TARGET_PATH,
      method: 'GET',
      headers: { Authorization: req.headers['authorization'] || '' },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamRes) => {
      log(`${upstreamRes.statusCode} forwarded`);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Timeout při volání ŘSD.'));
  });
  upstreamReq.on('error', (err) => {
    log(`error ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway: ' + err.message);
  });

  upstreamReq.end();
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`RSD home-proxy poslouchá na ${BIND_HOST}:${PORT} (proxy k ${TARGET_HOST})`);
});
