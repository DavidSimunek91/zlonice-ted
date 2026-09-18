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

- **Zdroj:** ŘSD/NDIC, portál mobilitydata.rsd.cz — odběr "DATEX II -
  Běžné dopravní informace v2 (snímek)" (PULL, DATEX II verze 2.3).
  Vybráno záměrně: appka nemá server na příjem, takže nešel PUSH varianta
  stejného zdroje (`Založit odběr` u ní čeká URL, na kterou by ŘSD sama
  posílala data).
- **Aktualizace:** `.github/workflows/update-traffic.yml`, každých 15 minut
- **Vyžaduje:** odběr schválený přes mobilitydata.rsd.cz + repo secrety
  `RSD_USERNAME` a `RSD_PASSWORD` (Basic Auth, ne API klíč v hlavičce —
  zadává se přímo ve formuláři odběru na portálu)
  (Settings → Secrets and variables → Actions → New repository secret)
- **Dokud secrety nejsou nastavené:** workflow nic nemění, soubor zůstává
  ve stavu `pending_access` a appka v sekci "Dopravní nehody v okolí"
  ukazuje "čeká se na přístup" — ne vymyšlená čísla.
- **Filtrování:** appka počítá vzdálenost každé situace od Zlonic
  (haversine, souřadnice ze `situationRecord` → `groupOfLocations` →
  `locationForDisplay`) a ukazuje jen ty do 20 km. Situace bez zjistitelné
  polohy v odpovědi appka záměrně přeskakuje, ne odhaduje.
- **Neověřeno proti živé odpovědi:** parser v `scripts/update-traffic.mjs`
  je napsaný podle standardní struktury DATEX II v2.3 "Situation
  Publication", ale nebyl při implementaci ověřený proti skutečné
  odpovědi tohohle konkrétního NDIC zdroje (nešlo předem získat vzorek).
  Po prvním ostrém běhu pipeline zkontroluj commit do `data/traffic.json`
  (nebo log běhu na GitHub Actions) — pokud struktura nesedí, skript by
  měl selhat čistě do `status:"error"` (viz komentáře přímo ve skriptu),
  appka mezitím ukáže "nelze ověřit".

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

## Řemeslníci a služby (`tradespeople.json`)

- **Zdroj 1 (páteř dat):** [ARES](https://ares.gov.cz) / Živnostenský
  rejstřík (RŽP) — veřejný registr, žádný klíč, CORS povolený i pro appku
  (appka na to i tak přímo nesahá, viz níž proč). Endpoint
  `ekonomicke-subjekty-rzp/{ico}` dává u každého živnostníka konkrétní
  živnosti (`predmetPodnikani`) — text jako "Zednictví" nebo "Montáž,
  opravy, revize a zkoušky elektrických zařízení", ne jen obecný kód oboru
  jako u dlaždice "Místní firmy podle oboru" výš. Dává i adresu místa
  podnikání a datum vzniku živnosti. **Nedává telefon ani e-mail** —
  živnostenský rejstřík tohle neeviduje, appka místo toho ukazuje jen to,
  co se podaří obohatit ze zdroje 2, jinak nic.
- **Zdroj 2 (jen obohacení kontaktu):** OpenStreetMap přes Overpass API —
  když se najde POI (`craft=*`/`shop=*`) se shodným jménem I oborem jako u
  ARES záznamu, přidá se telefon/web (viz `matchOsm()` ve skriptu).
  Pokrytí je nahodilé (jen kdo se sám zapsal do OSM/Mapy.cz) a shoda musí
  být jednoznačná — nikdy nepřidává nové lidi, jen občas dovybaví kontakt
  u někoho, koho už máme z ARESu.
  - **Overpass vyžaduje smysluplnou `User-Agent` hlavičku**, jinak rovnou
    vrací HTTP 429 (ověřeno) — viz hlavička ve skriptu. I tak je to
    jediný veřejný Overpass zdroj se sdíleným výstupním provozem napříč
    všemi uživateli, takže jednotlivé běhy občas selžou na 429/504 přetížením
    — skript v tom případě pokračuje BEZ obohacení kontaktů (nikdy nespadne
    kvůli tomuhle bonusu), zkusí to znovu příští týden.
  - firmy.cz / Zlaté stránky nemají otevřené API (jen komerční scraping
    služby typu Merk.cz) — proto se nepoužívají.
- **Rozsah (v1): jen samotné Zlonice** (kódObce 533114, RÚIAN — pokrývá i
  místní části jako Břešťany), ne okolní obce. Vědomé rozhodnutí kvůli
  rozsahu první verze, ne technické omezení — `KOD_OBCE` ve skriptu jde
  rozšířit na víc obcí, kdyby appka chtěla pokrýt širší okolí.
- **Co appka počítá za "řemeslníka":** jen živnosti, jejichž
  `predmetPodnikani` je v ruční mapě `PREDMET_TO_CATEGORY` ve skriptu (~20
  kategorií — zedník, elektrikář, instalatér, švadlena...). Obecná volná
  živnost ("Výroba, obchod a služby neuvedené v přílohách 1 až 3
  živnostenského zákona", má ji skoro každý OSVČ) se záměrně ignoruje, ať
  appka neukazuje kdejakého e-shopáře jako řemeslníka.
- **Aktualizace:** `.github/workflows/update-tradespeople.yml`, jednou
  týdně (pondělí) — živnostenský rejstřík se mění řádově měsíčně, častější
  běh by jen zbytečně zatěžoval ARES stovkami dotazů (jeden na osobu).
- **Bezpečnostní pravidla:**
  - Když selže seznam subjektů z ARESu úplně, nebo se podaří načíst míň
    než 70 % detailů aktivních živnostníků → celý běh skončí jako chyba a
    poslední DOBRÁ data zůstanou beze změny (stejné pravidlo jako u
    traffic/water pipeline).
  - Jednotlivé neúspěšné dotazy na pár konkrétních lidí (timeout) běh
    nezastaví, ten člověk se v daném běhu vynechá — loguje se kolik.
- **Veřejnost dat:** živnostenský rejstřík je ze zákona veřejný rejstřík
  přesně za účelem dohledatelnosti "kdo podniká v čem, kde" — appka tady
  nezveřejňuje nic, co by ARES/RŽP už samo nezveřejňovalo. Adresa je
  adresa **místa podnikání** (ne nutně trvalého bydliště), jak ji sám
  živnostník při registraci uvedl.

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

## Návštěvnost (`stats.json`)

- **Zdroj:** vlastní "maják" na droplu (`infra/visit-log/beacon-server.mjs`)
  — appka při každém načtení stránky pošle tichý požadavek s IP adresou
  a časem, žádné cookies ani trackování mezi weby. GitHub Pages appce
  žádné přístupové logy neposkytuje, proto vlastní řešení.
- **Aktualizace:** `scripts/aggregate-visits.mjs`, běží z cronu na droplu
  (`infra/do-pipelines`), ne z GitHub Actions — čte log ze souboru na
  disku droplu, GitHub Actions runner by na něj neviděl.
- **Retence 7 dní:** IP adresy se ukládají syrové (bez hashování), ale
  `aggregate-visits.mjs` při každém běhu ze zdrojového logu zahodí
  všechno starší než 7 dní — vědomý kompromis mezi jednoduchostí kódu a
  soukromím, ne přehlédnutí. Appka proto na `/stats.html` ukazuje jen
  krátký přehled, ne dlouhodobou historii.
- **Unikátní vs. opakované:** unikátní = počet různých IP adres v okně;
  opakované = kolik z nich se objevilo aspoň ve 2 různých dnech okna
  (jeden člověk, co obnoví stránku 5x za minutu, tak nevypadá jako
  "opakovaný návštěvník").
- Podrobný postup nasazení (DNS, Caddy, systemd, cron) je v
  `infra/visit-log/README.md`.

## Úřední deska (`uredni-deska.json`)

- **Zdroj:** RSS feed obecního webu, `zlonice.cz/uredni-deska?action=atom`
  — nescrapuje se HTML, feed dává rovnou title/link/popis/datum/přílohy
  na položku.
- **Aktualizace:** `scripts/update-uredni-deska.mjs`, běží z cronu na
  droplu (ne GitHub Actions) — potřebuje systémové `pdftoppm` a
  `tesseract` (viz níž), které GitHub Actions runner nemá bez extra
  instalace.
- **Proč OCR:** PDF přílohy na úřední desce jsou "Print to PDF" z KEO4 bez
  textové vrstvy (`pdftotext` z nich nedostane nic), ale vizuálně jde
  o ostrý, ne skenovaný text — OCR (`pdftoppm` 200 dpi → `tesseract -l ces`)
  z nich dostane prakticky přesný text.
  Vyžaduje jednorázově na droplu:
  `sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-ces`
- **Souhrn u rozpočtových opatření je deterministický, ne LLM:** skript
  najde v OCR textu první řádky "Příjmy celkem" a "Výdaje celkem" (součet
  za dané opatření, ne pozdější celoobecní součty v sekci "Změna závazných
  ukazatelů" ve stejném dokumentu) a spočítá rozdíl před/po. Vědomé
  rozhodnutí NEpoužívat LLM shrnutí: u veřejných peněz je riziko
  halucinace nepřijatelné, deterministický parser buď najde přesná čísla,
  nebo nenajde nic (viz níž).
- **Ostatní typy dokumentů** (vyhlášky, svolání zastupitelstva, uzavírky…):
  appka ukazuje skutečný úryvek textu, ne metadata o příloze. Zdroj (v
  pořadí, jak se zkouší): text přímo z RSS popisu (když ho úřad napsal
  rovnou tam) → náhled první strany přílohy (`pdftotext`, a když PDF nemá
  textovou vrstvu, OCR jen té jedné stránky, ne celého dokumentu) →
  teprve když ani jedno nevyjde, obecná hláška "ke stažení N příloh".
  Nikdy se nic nevymýšlí, jen se hledá skutečný text v dokumentu.
- **Když parser řádky "Příjmy/Výdaje celkem" nenajde** (jiný formát
  dokumentu, budoucí verze KEO4 apod.), položka se zobrazí jako obecná
  položka (viz výš) bez čísel — appka si nikdy nevymýšlí souhrn, který
  nedokázala spolehlivě přečíst.
- **`summary` je strukturovaný objekt**, ne hotová věta —
  `{ prijmy: {before, after, change, direction}, vydaje: {...} }` — appka
  si z něj sama poskládá barevné "chips" (`▲`/`▼` podle `direction`).
  Formátování čísel na Kč je jen v `update-uredni-deska.mjs`, ne
  duplikované v `index.html`.
- **Appka zobrazuje jen poslední ~30 dní** (filtruje se na frontendu podle
  `pubDate`, ne v pipeline — pipeline si `data/uredni-deska.json` drží víc
  položek jako pojistku), sekce je hned nahoře, nad počasím.
- **Zpracovává se jen jednou:** jakmile je položka (`id`) jednou úspěšně
  v `uredni-deska.json`, příští běhy ji jen převezmou beze změny — ať se
  pořád dokola nestahuje a neOCRuje totéž.
