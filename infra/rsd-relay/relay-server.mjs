// Malý transparentní relay pro ŘSD/NDIC (mobilitydata.rsd.cz) — běží na
// vlastním serveru s vlastní vyhrazenou IP (Oracle Cloud Always Free, viz
// README.md ve stejné složce), aby dopravní pipeline nešla přes sdílený
// výstupní IP fond Cloudflare Workers, kde nás sráží cizí provoz jiných
// zákazníků (viz commit historie scripts/update-traffic.mjs — ~75%
// chybovost). Dělá přesně to samé, co dřívější Cloudflare Worker: jen
// přeposílá požadavek dál a vrátí odpověď 1:1, nic si neukládá ani
// nezpracovává.
//
// Poslouchá jen na 127.0.0.1 — veřejný přístup + TLS zajišťuje Caddy
// (Caddyfile ve stejné složce) jako reverse proxy před tímhle procesem.
//
// Env proměnné:
//   PROXY_KEY   — musí sedět s hodnotou v GitHub secretu PROXY_KEY
//                 (stejná hodnota, co používal i Cloudflare Worker —
//                 nemusí se měnit, mění se jen RSD_PROXY_URL).
//   RELAY_PORT  — port pro localhost (výchozí 8787).

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = Number(process.env.RELAY_PORT || 8787);
const PROXY_KEY = process.env.PROXY_KEY;
const TARGET_HOST = 'mobilitydata.rsd.cz';
const TARGET_PATH = '/Resources/Dynamic/CommonTIDatex_v2/';
const UPSTREAM_TIMEOUT_MS = 20_000;

if (!PROXY_KEY) {
  console.error('PROXY_KEY není nastavený (env), končím.');
  process.exit(1);
}

const server = createServer((req, res) => {
  // Stejná pojistka jako u Cloudflare Workeru — chrání relay proti
  // zneužití jako veřejnou anonymní proxy, kdyby si někdo doménu/IP
  // všiml. Samo o sobě nic tajného neukládá.
  if (req.headers['x-proxy-key'] !== PROXY_KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const upstreamReq = httpsRequest(
    {
      hostname: TARGET_HOST,
      path: TARGET_PATH,
      method: 'GET',
      headers: { Authorization: req.headers['authorization'] || '' },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Timeout při volání ŘSD.'));
  });
  upstreamReq.on('error', (err) => {
    console.error('Chyba při volání ŘSD:', err.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway: ' + err.message);
  });

  upstreamReq.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RSD relay poslouchá na 127.0.0.1:${PORT} (proxy k ${TARGET_HOST})`);
});
