# RSD relay na vlastní IP (Oracle Cloud Always Free)

Náhrada za Cloudflare Worker (`RSD_PROXY_URL` secret) — stejná úloha (transparentně
přeposílá požadavek na `mobilitydata.rsd.cz` s Basic Auth hlavičkou), ale běží na
serveru s **vlastní vyhrazenou IP adresou** místo sdíleného výstupního fondu
Cloudflare Workers. Cloudflare Worker samotný zůstává v repu nedotčený (jen ho
přestaneme používat) — kdyby tahle varianta z nějakého důvodu nefungovala, stačí
`RSD_PROXY_URL` secret vrátit na starou hodnotu.

`scripts/update-traffic.mjs` se **nemění vůbec** — už dnes bere `RSD_PROXY_URL`
a `PROXY_KEY` z env/secrets, je mu jedno, jestli na druhé straně sedí Cloudflare
Worker nebo tenhle relay.

## 1. Založit Oracle Cloud účet

[cloud.oracle.com/free](https://www.oracle.com/cloud/free/) → Start for free.
Vyžaduje ověření platební kartou (kvůli identitě), na **Always Free** zdrojích se
nic nestrhává.

## 2. Vytvořit VM instanci

**Compute → Instances → Create Instance**

- Image: **Ubuntu 24.04** (nebo nejnovější LTS)
- Shape: cokoliv označené **"Always Free eligible"** (např. VM.Standard.E2.1.Micro,
  nebo Ampere A1 s 1 OCPU/6GB)
- V sekci **Networking**: nech zaškrtnuté "Assign a public IPv4 address" (zatím
  dostaneš dočasnou/ephemeral IP — statickou přiřadíme v kroku 3)
- V sekci **Add SSH keys**: nahraj svůj veřejný SSH klíč (nebo si nech vygenerovat
  a stáhni privátní klíč — bez SSH klíče se do VM nedostaneš)
- Create

## 3. Rezervovat statickou IP a přiřadit ji k VM

Tohle je klíčový krok — bez něj se IP při restartu VM změní.

**Networking → IP Management → Reserved Public IPs → Create Reserved Public IP**
- Pojmenuj ji (např. `rsd-relay-ip`) → Create

Pak ji přiřaď k VM:
- Jdi na svoji instanci → **Attached VNICs** → klikni na VNIC → **IPv4 Addresses**
- U existující (ephemeral) IP klikni **Edit** → **Reserved Public IP** → vyber tu,
  co jsi právě vytvořil → Update

Od teď je tahle IP adresa VM trvalá — **tuhle IP** bys případně nahlásil ŘSD.

## 4. Otevřít porty 80 a 443

Musí projít na **dvou** místech — Oracle to blokuje na úrovni cloudu i uvnitř VM:

**a) Security List / Network Security Group** (Networking → Virtual Cloud Networks
→ tvoje VCN → Security Lists → výchozí seznam → Add Ingress Rules):
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80`
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `443`

**b) Firewall uvnitř VM** (po SSH přihlášení, viz krok 6):
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # uloží pravidla i po rebootu (Ubuntu)
```

## 5. DNS — nasměrovat subdoménu na tu IP

Tam, kde spravuješ DNS pro `vezlonicich.cz` (stejné místo, kde je nastavený
GitHub Pages CNAME), přidej **A záznam**:

```
rsd-relay.vezlonicich.cz  →  <rezervovaná IP z kroku 3>
```

Caddy (krok 7) potřebuje, aby tohle fungovalo *předtím*, než si bude umět
vyžádat certifikát od Let's Encrypt.

## 6. Připojit se přes SSH a nainstalovat Node.js + Caddy

```bash
ssh -i cesta/k/privatnimu_klici ubuntu@<rezervovaná IP>

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (automatické HTTPS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 7. Nahrát soubory z tohohle adresáře na server

Z vlastního počítače (má-li `git clone` tohohle repa):

```bash
scp -i cesta/k/privatnimu_klici infra/rsd-relay/relay-server.mjs ubuntu@<IP>:/tmp/
scp -i cesta/k/privatnimu_klici infra/rsd-relay/Caddyfile ubuntu@<IP>:/tmp/
scp -i cesta/k/privatnimu_klici infra/rsd-relay/rsd-relay.service ubuntu@<IP>:/tmp/
```

Zpátky na serveru (přes SSH):

```bash
sudo mkdir -p /opt/rsd-relay
sudo mv /tmp/relay-server.mjs /opt/rsd-relay/
sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile
sudo mv /tmp/rsd-relay.service /etc/systemd/system/rsd-relay.service

sudo useradd --system --no-create-home --shell /usr/sbin/nologin rsd-relay
sudo chown -R rsd-relay:rsd-relay /opt/rsd-relay

# Nahraď REPLACE_ME skutečnou hodnotou GitHub secretu PROXY_KEY
# (stejná hodnota, co dřív dostal Cloudflare Worker)
sudo nano /etc/systemd/system/rsd-relay.service
```

## 8. Spustit obě služby

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rsd-relay
sudo systemctl enable --now caddy
sudo systemctl status rsd-relay caddy   # obě by měly být "active (running)"
```

## 9. Otestovat

```bash
# Bez klíče — očekáváme 403 Forbidden (relay běží, TLS funguje)
curl -i https://rsd-relay.vezlonicich.cz/

# Se správným klíčem, bez ŘSD přihlašovacích údajů — očekáváme 401 od ŘSD
# (potvrzuje, že relay skutečně dosáhl na mobilitydata.rsd.cz)
curl -i -H "X-Proxy-Key: <hodnota PROXY_KEY>" https://rsd-relay.vezlonicich.cz/
```

Pokud druhý příkaz vrátí `401 Unauthorized` (ne timeout, ne 522), relay funguje
a cesta k ŘSD je průchozí.

## 10. Přepnout GitHub Actions na nový relay

**Settings → Secrets and variables → Actions → `RSD_PROXY_URL`** → Update:

```
https://rsd-relay.vezlonicich.cz/
```

`PROXY_KEY` secret zůstává stejný, není potřeba ho měnit.

## 11. Ověřit end-to-end

Spustit `update-traffic.yml` ručně (Actions → Update traffic data →
Run workflow) a zkontrolovat, že `data/traffic.json` dostal čerstvý
`status:"ok"`.

## Pokud to ŘSD i tak blokuje

Napsat na `mobilitydata@rsd.cz` s žádostí o výjimku/allowlist přesně pro
rezervovanou IP z kroku 3 — je to teď jedna konkrétní, stálá adresa, ne
sdílený/měnící se rozsah.
