# CLAUDE.md

Pokyny pro Claude Code v tomhle repu (vezlonicich.cz — statický web +
sada datových pipeline). Přečti si tenhle soubor jako první, zvlášť
sekci **Infrastruktura ŘSD/NDIC proxy** níž, než se pustíš do čehokoli,
co volá `mobilitydata.rsd.cz` nebo mění proxy/droplet/notebook zapojení —
viz důvod na konci souboru.

## Co je co (rychlá orientace)

- `index.html` — celá appka, žádný framework. Čte jen `data/*.json`,
  nikdy nevolá externí API s neveřejnými přihlašovacími údaji přímo
  z prohlížeče.
- `scripts/update-*.mjs` — jednotlivé datové pipeline, viz
  **`data/README.md`** pro popis KAŽDÉHO zdroje (odkud, jak často, jaké
  secrety, jak appka degraduje, když secrety/data chybí). Tenhle soubor
  ten obsah neduplikuje.
- `.github/workflows/update-*.yml` — `workflow_dispatch`-only (GitHub
  Actions `schedule:` trigger má u tohohle repa zdokumentované zpoždění
  v řádu hodin, viz `infra/do-pipelines/README.md`) — záloha/ruční
  spuštění, ne zdroj pravdy.
- `infra/do-pipelines/` — skutečný zdroj pravdy: Linuxový cron na
  DigitalOcean droplu, co spouští tytéž `.mjs` skripty.
- **Bezpečnostní pravidla platná pro KAŽDOU pipeline v repu** (viz hlavička
  každého `scripts/update-*.mjs` pro přesné znění): cokoli se nepovede
  (síť/auth/formát) → explicitní `status:"error"`, nikdy tiše vymyšlené/
  nulové/prázdné "žádná data". Appka navíc kontroluje stáří `updated`.
  Nikdy nehádej/needstimej chybějící pole (poloha, hodnota) — raději
  záznam přeskoč, než si ho domysli.

## Infrastruktura ŘSD/NDIC proxy — AKTUÁLNÍ STAV (ověřeno 2026-10-31)

ŘSD/NDIC (`mobilitydata.rsd.cz`) blokuje spojení z cloudových/
datacentrových IP rozsahů — potvrzeno u GitHub Actions (Azure),
DigitalOcean droplu, a dvou dřívějších proxy řešení (viz chronologie
níž). **Tohle se v historii repa třikrát řešilo třemi různými proxy a
nikde to nebylo svedené na jedno místo, co je zrovna živé — proto tenhle
oddíl.** Kdo se do ŘSD/NDIC pipeline (doprava, zimní sjízdnost, nebo
cokoli dalšího z `mobilitydata.rsd.cz` v budoucnu) pustí bez přečtení
tohohle oddílu, riskuje přesně tu chybu, co se stala 31.10.2026: nový
kus kódu navržený proti domněle aktuální, ale ve skutečnosti zastaralé
architektuře (viz "Co se pokazilo" níž).

**ŽIVÉ dnes:** `home-proxy/` — Node relay běžící jako Windows služba na
osobním MSI notebooku Davida Šimůnka, napojený na droplet přes Tailscale
(WireGuard, privátní síť, žádná veřejná doména/port forwarding). Droplet
posílá požadavek s Basic Auth hlavičkou na `RSD_PROXY_URL` (Tailscale IP
notebooku), notebook ho transparentně přepošle na `mobilitydata.rsd.cz`
ze své rezidentní IP (tu ŘSD neblokuje) a odpověď vrátí 1:1 zpátky. Proxy
samotná ŘSD přihlašovací údaje nezná, jen sdílený `PROXY_KEY` token.
Cílová ŘSD cesta se vybírá podle cesty požadavku na proxy, z pevné
allowlisty v `home-proxy/server.mjs` (`TARGET_PATHS`) — `/` a `/traffic`
jdou na dopravu, `/winter` na zimní sjízdnost. **Přidáváš nový ŘSD/NDIC
zdroj?** Přidej mu novou cestu do týž allowlisty (ne nový proxy server) a
dej vědět uživateli, že potřebuje na notebooku `git pull` +
`nssm restart RsdHomeProxy` — žádná nová hodnota v `home-proxy/.env` není
potřeba. Návod/ověření: `home-proxy/README.md`.

**NEAKTIVNÍ/legacy (kód zůstává jako historie/záloha, ne jako zdroj
pravdy):**
- `infra/rsd-relay/` — Oracle Cloud relay (PR #27, srpen 2026). Měl
  vyhrazenou IP místo sdíleného fondu Cloudflare Workers, ale podle PR #44
  byl v době vzniku home-proxy pravděpodobně i on sám blokovaný.
- Cloudflare Worker (PR #20, srpen 2026, kód mimo tenhle repo) — první
  řešení, ~25 % úspěšnost kvůli sdílenému výstupnímu IP fondu Cloudflare
  napříč všemi zákazníky. `RSD_PROXY_URL`/`PROXY_KEY` mechanismus ve
  skriptech od něj zůstal (proxy-agnostický), jen dnes míří jinam.

**Chronologie (ověřeno přes `pull_request_read`, ne jen z paměti):**
PR #20 (10.8.2026, Cloudflare Worker) → PR #27 (15.8.2026, Oracle relay,
"Cloudflare Worker zůstává funkční jako záloha") → PR #30 (droplet cron,
`infra/do-pipelines/`) → PR #44 (3.10.2026, `home-proxy/`, protože droplet
i pravděpodobně i Oracle relay byly blokované) → dnešek: `home-proxy/`
jediné živé.

**Když měníš, co je živé** (nová proxy generace, zrušení Tailscale,
cokoli): aktualizuj tenhle oddíl v tom samém PR, ne jen `data/README.md`
nebo `infra/*/README.md` — ty popisují JEDNOTLIVÁ řešení, tenhle soubor
říká, KTERÉ z nich platí teď.

### Co se pokazilo 31.10.2026 (pro příští podobnou situaci)

Implementace pipeline pro zimní sjízdnost (`scripts/update-winter-
roads.mjs`, PR #56) vznikla bez proxy fallbacku — návrh vycházel z
`infra/do-pipelines/README.md`, který v té době ještě popisoval Cloudflare
Worker jako aktuální řešení a `infra/rsd-relay/` zmiňoval jako jedinou
alternativu. Repo-wide grep po `Cloudflare Worker`/`X-Proxy-Key` ale i
tehdy vracel zásahy v `home-proxy/README.md` a `home-proxy/server.mjs` —
ty se ale nikdy nepřečetly, protože `infra/do-pipelines/README.md` (již
přečtený) působil jako dostatečný zdroj pravdy. Až uživatelova zpráva o
"MSI notebooku jako serveru" to odhalila (PR #57 opravil proxy
zapojení). Poučení: repo-wide grep ukázal správný soubor, ale nestačilo
ho jen najít — bylo potřeba ho i přečíst, ne věřit staršímu, už
přečtenému dokumentu jako kompletnímu obrazu.
