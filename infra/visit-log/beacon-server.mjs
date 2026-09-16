// Malý "maják" pro počítání návštěv vezlonicich.cz — běží natrvalo na
// droplu (systemd služba), appka na něj z prohlížeče při každém načtení
// stránky pošle jeden tichý požadavek (fetch s mode:'no-cors', viz
// index.html). Server si jen zapíše IP adresu a čas do souboru, nic víc
// (žádné cookies, žádný fingerprinting, žádné trackování mezi weby).
//
// Soukromí — vědomý kompromis, ne přehlédnutí: IP adresa se ukládá
// nezakódovaná (ne hash), ale jen na 7 dní — scripts/aggregate-visits.mjs
// běží pravidelně na droplu a při každém běhu ze souboru vyhodí všechno
// starší než týden. Jednodušší kód než hashování/anonymizace hned při
// zápisu, za cenu kratší, ale ne nulové retence syrové IP.
//
// Proč vlastní maják, ne GitHub Pages logy: GitHub Pages žádné přístupové
// logy majiteli repa neposkytuje (na rozdíl od klasického hostingu).

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = 8788; // jen localhost, ven pouští Caddy (viz README.md)
const LOG_PATH = process.env.VISIT_LOG_PATH || `${process.env.HOME}/vezlonicich-visits.ndjson`;

mkdirSync(dirname(LOG_PATH), { recursive: true });

function clientIp(req){
  // Caddy jako reverse proxy nastavuje X-Forwarded-For — bez něj bychom
  // tady viděli jen 127.0.0.1 (adresu samotného Caddy), ne skutečného
  // návštěvníka.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const server = createServer((req, res) => {
  if (req.url === '/hit'){
    try {
      const line = JSON.stringify({ ip: clientIp(req), ts: new Date().toISOString() });
      appendFileSync(LOG_PATH, line + '\n');
    } catch (err) {
      console.error('Zápis návštěvy selhal:', err);
    }
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Beacon server naslouchá na 127.0.0.1:${PORT}, log: ${LOG_PATH}`);
});
