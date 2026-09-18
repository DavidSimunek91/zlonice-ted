// Aktualizuje data/uredni-deska.json — nové položky z úřední desky Městyse
// Zlonice (www.zlonice.cz/uredni-deska), čteno z jejich RSS feedu.
//
// Běží JEN na droplu (infra/do-pipelines/), ne přes GitHub Actions — potřebuje
// systémové nástroje `pdftoppm` a `tesseract`, které GitHub Actions runner
// nemá bez extra instalace a droplet je má nainstalované jednorázově ručně
// (stejný důvod jako `unzip` u scripts/update-departures.mjs):
//   sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-ces
//
// Proč OCR: PDF přílohy na úřední desce (KEO4 "Print to PDF") nemají
// textovou vrstvu — pdftotext z nich nedostane nic. Vizuálně je ale text
// ostrý (ne sken papíru), takže OCR přes tesseract dává velmi kvalitní
// výsledek — ověřeno ručně na "Rozpočtové opatření č. 3/2026".
//
// Souhrn u rozpočtových opatření je NAMÍRNĚ deterministický parser, žádné
// LLM: vytáhne z OCR textu řádky "Příjmy celkem" a "Výdaje celkem" (první
// výskyt v dokumentu = součet za tohle konkrétní opatření, ne za celý
// rozpočet obce) a spočítá rozdíl před/po. Když se to nepovede rozpoznat
// (jiný formát dokumentu), NEPÍŠEME žádný vymyšlený souhrn — položka se
// zobrazí jen jako "nový dokument ke stažení", ať jde o veřejné peníze.
// `summary` je strukturovaný objekt (čísla + text, ne hotová věta) — appka
// si z něj sama poskládá barevné "chips", formátování zůstává tady na
// jednom místě.
//
// U ostatních typů dokumentů appka dřív ukazovala jen "ke stažení N
// příloh" — to je metadata o příloze, ne informace pro občana. Teď se
// zkusí vzít první smysluplný text: buď z RSS popisu (když ho úřad napsal
// rovnou tam), jinak náhled první strany přílohy (pdftotext, a když PDF
// nemá textovou vrstvu, OCR jen té jedné stránky — ne celého dokumentu,
// ať se to zbytečně neprotahuje). Nikdy nic nevymýšlíme, jen buď najdeme
// skutečný text v dokumentu, nebo se vrátíme k obecné hlášce.
//
// Položky se zpracovávají (a OCR) jen jednou — jakmile je `id` jednou
// úspěšně v data/uredni-deska.json, příští běhy ho jen převezmou beze
// změny, aby se pořád dokola nestahovalo a neOCRovalo totéž.

import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';

const OUT_PATH = 'data/uredni-deska.json';
const FEED_URL = 'https://www.zlonice.cz/uredni-deska?action=atom';
// appka na FE filtruje na posledních ~30 dní, tenhle strop je jen pojistka
// pro případ, že by RSS feed najednou obsahoval mnohem víc položek
const MAX_ITEMS = 30;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

function checkBinary(cmd, args) {
  const r = spawnSync(cmd, args);
  if (r.error) {
    throw new Error(
      `Chybí systémový nástroj "${cmd}" — na droplu spusť: sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-ces`
    );
  }
}

function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFileUrls(rawDescription) {
  const oids = new Set();
  for (const m of rawDescription.matchAll(/file\.php\?oid=(\d+)/g)) oids.add(m[1]);
  return [...oids].map((oid) => `https://www.zlonice.cz/file.php?oid=${oid}`);
}

function extractId(value) {
  const m = String(value || '').match(/[?&]id=(\d+)/);
  return m ? Number(m[1]) : null;
}

// Appka má na úřední desce zůstat kompaktní (max pár řádků na položku),
// takže se ořezává na počet slov, ne znaků — krátká "core message", ne
// odstavec.
const NOTE_MAX_WORDS = 15;

function truncateWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '…';
}

// Když se nepodaří najít žádný skutečný text (ani v RSS popisu, ani
// v příloze) — poslední záchrana, aspoň řekne kolik příloh tam je.
function fallbackNote(fileCount) {
  if (fileCount > 0) {
    const word = fileCount === 1 ? 'přílohu' : fileCount < 5 ? 'přílohy' : 'příloh';
    return `Nová položka na úřední desce, ke stažení ${fileCount} ${word}.`;
  }
  return 'Nová položka na úřední desce.';
}

// Text přímo z RSS popisu (když ho úřad napsal rovnou tam, ne jen jako
// seznam odkazů na přílohy) — nejlevnější a nejspolehlivější zdroj náhledu.
function descriptionPreview(rawDescription) {
  const beforeAttachments = rawDescription.split(/Přílohy\s*:/i)[0];
  const text = htmlToText(beforeAttachments);
  return text || null;
}

// Řádky, které se opakují na každé stránce/dokumentu ("hlavička" KEO4
// i běžných obecních tiskopisů) — nenesou žádnou informaci o obsahu.
const BOILERPLATE_LINE_RE = [
  /^Městys Zlonice/i,
  /^KEO4/i,
  /^Zpracováno programem/i,
  /^IČO[:\s]/i,
  /^\d+\/\d+$/, // číslo strany typu "1/3"
  /^Nám\.? Pod Lipami/i, // adresa v hlavičce tiskopisů úřadu
  /^\d{3}\s?\d{2}\s+\S/, // PSČ + obec, pokračování adresy na dalším řádku
];

function cleanPreviewText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter((l) => !BOILERPLATE_LINE_RE.some((re) => re.test(l)));
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

// Náhled první strany přílohy: nejdřív zkusí přímo textovou vrstvu
// (rychlé, žádné OCR), a jen když je prázdná/skoro prázdná (PDF bez
// textové vrstvy, viz hlavička souboru), spadne na OCR té jedné stránky.
async function extractDocPreview(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Stažení přílohy selhalo (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'uredni-deska-'));
  try {
    const pdfPath = join(dir, 'doc.pdf');
    writeFileSync(pdfPath, buf);

    checkBinary('pdftotext', ['-v']);
    let text = '';
    try {
      text = execFileSync('pdftotext', ['-f', '1', '-l', '1', pdfPath, '-'], {
        maxBuffer: 5 * 1024 * 1024,
      }).toString('utf-8');
    } catch {
      text = '';
    }

    if (cleanPreviewText(text).length < 40) {
      checkBinary('pdftoppm', ['-v']);
      checkBinary('tesseract', ['--version']);
      execFileSync('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', '1', pdfPath, join(dir, 'page')]);
      const pages = readdirSync(dir).filter((f) => f.startsWith('page') && f.endsWith('.png'));
      if (pages.length > 0) {
        text = execFileSync('tesseract', [join(dir, pages[0]), 'stdout', '-l', 'ces'], {
          maxBuffer: 5 * 1024 * 1024,
        }).toString('utf-8');
      }
    }
    return cleanPreviewText(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function formatKc(n) {
  const rounded = Math.round(n * 100) / 100;
  const opts = Number.isInteger(rounded) ? undefined : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${rounded.toLocaleString('cs-CZ', opts)} Kč`;
}

// Bere první výskyt daného řádku v dokumentu — u "Rozpočtové opatření" to
// je součet za samotné opatření (viz komentář v hlavičce souboru), ne za
// pozdější sekci "Změna závazných ukazatelů" s celoobecními součty.
function extractTotalLine(text, label) {
  const re = new RegExp(`${label}\\s+(-?[0-9][0-9 ]*,\\d{2})\\s+(-?[0-9][0-9 ]*,\\d{2})\\s+(-?[0-9][0-9 ]*,\\d{2})`);
  const m = text.match(re);
  if (!m) return null;
  const num = (s) => Number(s.replace(/\s/g, '').replace(',', '.'));
  return { before: num(m[1]), change: num(m[2]), after: num(m[3]) };
}

function toChip(t) {
  if (!t) return null;
  return {
    before: formatKc(t.before),
    after: formatKc(t.after),
    change: `${t.change >= 0 ? '+' : ''}${formatKc(t.change)}`,
    direction: t.change > 0 ? 'up' : t.change < 0 ? 'down' : 'flat',
  };
}

// Vrací strukturovaná data (čísla už naformátovaná na Kč), ne hotovou
// větu — appka si z toho poskládá barevné chips. Formátování je schválně
// tady na jednom místě, ne duplikované v index.html.
function buildRozpocetSummary(text) {
  const prijmy = extractTotalLine(text, 'Příjmy celkem');
  const vydaje = extractTotalLine(text, 'Výdaje celkem');
  if (!prijmy && !vydaje) return null;
  return { prijmy: toChip(prijmy), vydaje: toChip(vydaje) };
}

async function ocrPdf(url) {
  checkBinary('pdftoppm', ['-v']);
  checkBinary('tesseract', ['--version']);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Stažení přílohy selhalo (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'uredni-deska-'));
  try {
    const pdfPath = join(dir, 'doc.pdf');
    writeFileSync(pdfPath, buf);
    execFileSync('pdftoppm', ['-r', '200', '-png', pdfPath, join(dir, 'page')]);
    const pages = readdirSync(dir).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    let text = '';
    for (const page of pages) {
      text += execFileSync('tesseract', [join(dir, page), 'stdout', '-l', 'ces'], {
        maxBuffer: 10 * 1024 * 1024,
      }).toString('utf-8') + '\n';
    }
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const res = await fetchWithRetry(FEED_URL);
  if (!res.ok) throw new Error(`Nepodařilo se načíst RSS úřední desky (HTTP ${res.status})`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => name === 'item' });
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item;
  if (!Array.isArray(items)) throw new Error('RSS feed nemá očekávanou strukturu (chybí rss/channel/item)');

  let existing = [];
  if (existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_PATH, 'utf-8'));
      if (Array.isArray(prev.items)) existing = prev.items;
    } catch {
      // Poškozený předchozí soubor — začínáme znovu od RSS feedu.
    }
  }
  const existingById = new Map(existing.map((it) => [it.id, it]));

  const result = [];
  for (const raw of items) {
    const id = extractId(raw.guid || raw.link);
    if (id == null) continue;

    if (existingById.has(id)) {
      result.push(existingById.get(id));
      continue;
    }

    const title = String(raw.title || '').trim();
    const link = `https://www.zlonice.cz/uredni-deska?id=${id}&action=detail`;
    const pubDateParsed = raw.pubDate ? new Date(raw.pubDate) : null;
    const pubDate = pubDateParsed && !isNaN(pubDateParsed) ? pubDateParsed.toISOString() : null;
    const rawDescription = String(raw.description || '');
    const fileUrls = extractFileUrls(rawDescription);
    const isRozpocet = /rozpočtov[ée] opat[řr]en[íi]/i.test(title);

    let entry = {
      id,
      title,
      link,
      pubDate,
      type: 'other',
      summary: null,
      note: null,
      fileUrl: fileUrls[0] || null,
    };

    if (isRozpocet && fileUrls[0]) {
      try {
        const text = await ocrPdf(fileUrls[0]);
        const summary = buildRozpocetSummary(text);
        if (summary) {
          entry.type = 'rozpocet';
          entry.summary = summary;
        } else {
          console.warn(`Položka ${id}: OCR proběhlo, ale nenašel jsem řádky "Příjmy/Výdaje celkem" — beru jako obecnou položku.`);
          const fallbackDescription = descriptionPreview(rawDescription);
          entry.note = fallbackDescription ? truncateWords(fallbackDescription, NOTE_MAX_WORDS) : fallbackNote(fileUrls.length);
        }
      } catch (err) {
        console.warn(`Položka ${id}: OCR přílohy selhalo (${err.message}), zkusím znovu příští běh.`);
        continue; // nepřidávat teď — příští běh to zkusí znovu, ne natrvalo bez souhrnu
      }
    } else {
      const fromDescription = descriptionPreview(rawDescription);
      if (fromDescription) {
        entry.note = truncateWords(fromDescription, NOTE_MAX_WORDS);
      } else if (fileUrls[0]) {
        try {
          const preview = await extractDocPreview(fileUrls[0]);
          entry.note = preview ? truncateWords(preview, NOTE_MAX_WORDS) : fallbackNote(fileUrls.length);
        } catch (err) {
          console.warn(`Položka ${id}: náhled přílohy selhal (${err.message}), zobrazí se jen obecná hláška.`);
          entry.note = fallbackNote(fileUrls.length);
        }
      } else {
        entry.note = fallbackNote(0);
      }
    }

    result.push(entry);
  }

  result.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  const output = {
    status: 'ok',
    updated: new Date().toISOString(),
    items: result.slice(0, MAX_ITEMS),
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Hotovo: ${output.items.length} položek na úřední desce.`);
}

main().catch((err) => {
  console.error('Aktualizace úřední desky selhala:', err);
  let previousWasOk = false;
  try {
    if (existsSync(OUT_PATH)) previousWasOk = JSON.parse(readFileSync(OUT_PATH, 'utf-8'))?.status === 'ok';
  } catch {
    // Poškozený předchozí soubor — nemáme co zachovat.
  }
  if (previousWasOk) {
    console.log('Poslední data byla v pořádku, ponechávám je beze změny místo přepsání chybou.');
    return;
  }
  const output = { status: 'error', updated: new Date().toISOString(), message: String(err.message || err) };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
});
