# Data pipeline

Appka je pořád čistý statický web (HTML/CSS/vanilla JS), žádný framework,
žádná databáze. Soubory v téhle složce jsou ale výjimka z pravidla
"appka si všechno tahá živě z API v prohlížeči" — generuje je automat
(GitHub Actions) na pozadí, ne appka sama při načtení stránky.

Důvod je jeden ze dvou:
1. **Potřeba API klíč** (ŘSD/NDIC) — klíč nejde dát do klientského JS appky,
   protože by byl veřejně vidět úplně každému (appka nemá žádný server, kde
   by se dal schovat). Skript ho drží jako tajný GitHub Actions secret.
2. **Zdroj nemá CORS hlavičky** (ČHMÚ, PID GTFS) — prohlížeč by fetch z
   `github.io` sám zablokoval, ať by appka dělala cokoli. Žádný klíč tu
   není potřeba, jen musí to volání proběhnout mimo prohlížeč.

V obou případech: malý skript běží na časovač mimo appku, výsledek
zjednoduší a uloží sem jako obyčejný JSON. Appka pak ten soubor čte úplně
stejně snadno jako Open-Meteo.

## Doprava (`traffic.json`)

- **Zdroj:** ŘSD/NDIC, portál mobilitydata.rsd.cz (formát DATEX II)
- **Aktualizace:** `.github/workflows/update-traffic.yml`, každých 15 minut
- **Vyžaduje:** registraci na mobilitydata.rsd.cz + repo secret `RSD_API_KEY`
  (Settings → Secrets and variables → Actions → New repository secret)
- **Dokud secret není nastavený:** workflow nic nemění, soubor zůstává ve
  stavu `pending_access` a appka v sekci "Dopravní nehody v okolí" ukazuje
  "připravujeme" — ne vymyšlená čísla.

Až přijde přístup od ŘSD, zbývá doplnit skutečné volání API do
`scripts/update-traffic.mjs` (přesné místo je tam označené `TODO`) a
appku napojit na čtení `data/traffic.json` místo textu "připravujeme".

## Výstrahy ČHMÚ (`alerts.json`)

- **Zdroj:** opendata.chmi.cz, CAP/XML formát (celostátní bulletin, ~2 MB)
- **Aktualizace:** `.github/workflows/update-alerts.yml`, každých 10 minut
- **Filtrování:** appka je pro obec Zlonice, která spadá pod **ORP Slaný**
  (kód CISORP `2124`) — ne ORP Kladno, i když je Zlonice v okrese Kladno.
  Tohle je ověřený detail (ČSÚ + přímo v CAP datech), ne odhad — záměna by
  appce dávala výstrahy pro jinou oblast.
- **Bezpečnostní pravidla, která se neobcházejí** (viz komentáře přímo ve
  `scripts/update-alerts.mjs`):
  - Když cokoli selže (síť, formát dat), skript napíše explicitní
    `status: "error"`, nikdy tiše "beze zvláštních výstrah".
  - Appka sama kontroluje stáří pole `updated` — když se pipeline zasekne
    (stalo se nám to u GitHub Pages, může se to stát i tady), appka
    přestane věřit starým datům a ukáže "nelze ověřit", ne poslední
    známý stav.

## Autobusy (`departures.json`)

- **Zdroj:** PID (Pražská integrovaná doprava) GTFS statická data,
  `data.pid.cz/PID_GTFS.zip` (~46 MB, CC-BY licence, PID ho sám generuje
  jednou denně kolem 4:00)
- **Aktualizace:** `.github/workflows/update-departures.yml`, jednou denně
  (jde jen o jízdní řád, ne živou polohu — častější běh by nic nezměnil)
- **Filtrování:** appka je pro Zlonice, takže se z celého PID systému
  (metro, tramvaje, stovky linek) vybírají jen linky **590, 591, 594**
  a zastávky se jménem začínajícím "Zlonice" — jinak by výsledný soubor
  musel obsahovat kus celého Česka.
- **Co appka počítá sama, ne pipeline:** "další odjezdy za X minut" se
  počítá v prohlížeči z aktuálního data/dne v týdnu a kalendáře platnosti
  spojů (`calendar.txt` + výjimky z `calendar_dates.txt`), ne z
  předpočítaného seznamu — jinak by po pár hodinách appka ukazovala
  odjezdy, co už dávno ujely.
- **Navíc ukládá `stopIds`** (jméno zastávky → GTFS stop_id) a `tripId` u
  každého spoje — vstup pro `update-live-departures.mjs` níž, ať nemusí
  znovu stahovat a prohledávat celý zip jen kvůli pár ID.
- **Co appka NEukazuje:** výluky, live polohu autobusu na mapě — jen
  zpoždění (viz níž) a jízdní řád.

## Živé zpoždění autobusů (`live-departures.json`)

- **Zdroj:** [Golemio API](https://api.golemio.cz/pid/docs/openapi/)
  (Pražská datová platforma, pod kterou spadá i PID), endpoint
  `GET /v2/pid/departureboards` — vrací odjezdy pro dané `stop_id` rovnou
  s živým zpožděním (`predicted` vs. `scheduled` čas, `delay.minutes`,
  `is_canceled`, `is_at_stop`), ne surová GTFS-RT protobuf data, která by
  se musela dekódovat.
- **Aktualizace:** `.github/workflows/update-live-departures.yml`, každých
  5 minut.
- **Vyžaduje:** repo secret `GOLEMIO_API_KEY` — na rozdíl od ŘSD/NDIC je
  registrace samoobslužná a okamžitá (jen e-mailové ověření), zdarma na
  [api.golemio.cz/api-keys](https://api.golemio.cz/api-keys).
- **Dokud secret není nastavený:** workflow nic nevolá, soubor zůstává ve
  stavu `pending_access` a appka zpoždění prostě nezobrazuje — jízdní řád
  funguje dál beze změny, ne s vymyšlenými čísly.
- **Párování se statickým jízdním řádem:** appka spojuje živé zpoždění s
  konkrétním spojem podle `tripId` (GTFS trip ID, stejný formát na obou
  stranách) — spolehlivější než párování podle času odjezdu a linky, kde
  by mohla nastat shoda náhodou.
- **Stejná bezpečnostní zásada jako jinde:** appka kontroluje stáří pole
  `updated` (práh 30 minut, pipeline běží co 5) a při zastaralosti nebo
  chybě zpoždění tiše skryje, ne že by ukázala starou hodnotu jako
  aktuální — pro tenhle konkrétní údaj je "nic" bezpečnější než "asi".

## Voda (`water.json`)

- **Zdroj:** ČHMÚ hydrologická opendata, stanice **Velvary** (tok Bakovský
  potok, 16 km od Zlonic — nejbližší reálná stanice), `objID 0-203-1-202300`
- **Aktualizace:** `.github/workflows/update-water.yml`, každých 15 minut
  — ČHMÚ tahle data sám aktualizuje každých 10 minut, takže dřívější
  ručně vkládaný snímek nikdy nebyl dostatečně čerstvý pro appku jménem
  "Ve Zlonicích"
- **Prahové hodnoty** (sucho/1./2./3. stupeň povodňové aktivity) se čtou
  živě z metadat stanice při každém běhu, ne natvrdo v kódu — kdyby je
  ČHMÚ někdy upravil
- **Teplota vody:** appka ji interpretuje vůči zákonnému limitu pro
  kaprové vody (28 °C, nařízení vlády č. 401/2015 Sb.) — Bakovský potok
  je nížinný, kaprový tok, takže je to relevantní referenční hodnota,
  ne odhad
- **Stejná bezpečnostní zásada jako u výstrah:** appka kontroluje stáří
  pole `updated` a při zastaralosti ukáže "nelze ověřit", ne poslední
  známou (možná zastaralou) hodnotu
