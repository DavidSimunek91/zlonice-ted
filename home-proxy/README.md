# Domácí RSD proxy (Windows notebook + Tailscale)

## Proč tohle existuje

ŘSD/NDIC blokuje spojení z cloudových/datacentrových IP rozsahů — potvrzeno
u Azure (GitHub Actions), DigitalOcean (droplet) i sdíleného výstupního
fondu Cloudflare Workers. Řešení: pustit dopravní pipeline přes **rezidentní
IP adresu** domácího připojení, kde takovou blokaci čekat nelze.

`scripts/update-traffic.mjs` **se nemění vůbec**. Posílá Basic Auth hlavičku
(`RSD_USERNAME`/`RSD_PASSWORD`) sám, ať volá ŘSD přímo, nebo přes
`RSD_PROXY_URL` — tenhle proxy ji jen beze změny přeposílá dál. Proto
**proxy na notebooku vůbec nezná přístupové údaje k ŘSD**, jen sdílený
`PROXY_KEY` token (stejné jméno, co dřív používal Cloudflare Worker a
Oracle relay v `infra/rsd-relay/`). Pozor na jednu věc: ta Basic Auth
hlavička tímhle procesem fyzicky protéká (je to transparentní relay) — jen
se nikde neukládá ani neloguje.

Spojení mezi dropletem a notebookem jde přes **Tailscale** — soukromou síť
s WireGuard šifrováním mezi oběma stroji. Žádná veřejná doména, žádný
port forwarding na routeru, žádný certifikát, žádné DNS změny na
`vezlonicich.cz`:

```
droplet (cron, co 15 min)
  → RSD_PROXY_URL = http://<tailscale-ip-notebooku>:8787
    (přes Tailscale, šifrovaně, mimo veřejný internet)
      → notebook: proxy (X-Proxy-Key jako druhá pojistka)
        → mobilitydata.rsd.cz  (přes DOMÁCÍ IP)
```

## 0. Co budeš potřebovat

- Windows notebook, trvale zapnutý a připojený k internetu
- práva administrátora (instalace služeb)
- Tailscale účet (zdarma, stačí přihlášení přes Google/Microsoft/GitHub)
- SSH přístup na droplet (pro krok 3 a 6)

## 1. Node.js

```powershell
winget install OpenJS.NodeJS.LTS
```

Zavři a znovu otevři PowerShell (ať se načte PATH), ověř:

```powershell
node --version
```

## 2. Stáhnout repo a připravit proxy

```powershell
cd C:\
git clone https://github.com/DavidSimunek91/zlonice-ted.git
cd zlonice-ted\home-proxy
Copy-Item env.example .env
```

Vygeneruj náhodný token a vlož ho do `.env` (otevři `notepad .env`):

```powershell
-join ((48..57)+(97..102)|Get-Random -Count 48|%{[char]$_})
```

Výstup zkopíruj jako hodnotu `PROXY_KEY=` v `.env`. **Tenhle token napiš
i do poznámek** — za chvíli ho budeš potřebovat i na droplu (krok 5).
`BIND_HOST` v `.env` nech zatím zakomentovaný — doplníš ho v kroku 3, až
budeš znát Tailscale IP.

## 3. Tailscale — notebook

```powershell
winget install Tailscale.Tailscale
```

Spusť Tailscale (z nabídky Start, nebo `tailscale.exe` v `C:\Program Files\Tailscale\`)
a přihlas se stejným účtem, který použiješ i na droplu (krok 4) — oba
stroje musí být ve stejném tailnetu.

**Důležité — "unattended mode":** v Tailscale ikoně v system tray →
Preferences (ozubené kolo) → zaškrtni **"Run unattended"** (nebo
"Allow Tailscale to run on startup, even when not logged in"). Bez tohohle
se Tailscale po restartu nepřipojí, dokud se někdo nepřihlásí do Windows.

Zjisti přidělenou Tailscale IP:

```powershell
tailscale ip -4
```

Zapiš si ji (tvar `100.x.y.z`) a vlož do `home-proxy\.env`:

```
BIND_HOST=100.x.y.z
```

## 4. Tailscale — droplet

Na droplu (SSH):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Vypíše přihlašovací odkaz — otevři ho v prohlížeči a přihlas se **stejným
účtem jako na notebooku** (krok 3). Ověř, že droplet vidí notebook:

```bash
tailscale status
```

Měl bys v seznamu vidět i notebook se stejnou IP, co jsi zjistil v kroku 3.

## 5. Proxy jako služba Windows (NSSM)

```powershell
winget install NSSM.NSSM
```

(Pokud by winget balíček nenašel, stáhni ručně z https://nssm.cc/download
a rozbal `nssm.exe` třeba do `C:\nssm\`.)

```powershell
nssm install RsdHomeProxy "C:\Program Files\nodejs\node.exe" "C:\zlonice-ted\home-proxy\server.mjs"
nssm set RsdHomeProxy AppDirectory "C:\zlonice-ted\home-proxy"
nssm set RsdHomeProxy AppExit Default Restart
nssm set RsdHomeProxy AppRestartDelay 5000
nssm set RsdHomeProxy Start SERVICE_AUTO_START
nssm start RsdHomeProxy
```

Ověř: `nssm status RsdHomeProxy` → `SERVICE_RUNNING`.

Windows firewall — povol příchozí spojení na port 8787, ale jen z
Tailscale rozsahu (ne ze zbytku internetu — zvenku stejně díky Tailscale
není proxy vidět, tohle je jen druhá vrstva opatrnosti):

```powershell
New-NetFirewallRule -DisplayName "RSD Home Proxy (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 8787 -RemoteAddress 100.64.0.0/10 -Action Allow
```

Otestuj z notebooku samotného:

```powershell
curl.exe -i http://127.0.0.1:8787/health          # čekej: 200 ok
curl.exe -i http://<tvoje Tailscale IP>:8787/      # čekej: 401 Unauthorized (bez tokenu)
```

## 6. Droplet — zapojit do pipeline

Na droplu do `~/zlonice-ted.env` (odkomentuj/dopiš, nahraď Tailscale IP a
token skutečnými hodnotami z kroků 3 a 2):

```bash
export RSD_PROXY_URL="http://100.x.y.z:8787/"
export PROXY_KEY="<stejný token, co máš v home-proxy/.env>"
```

(`http://`, ne `https://` — šifrování řeší Tailscale sám, tenhle přenos
nikdy neopustí privátní síť, takže TLS navíc tady nic nepřidává.)

Ruční test přímo z dropletu (ověří, že droplet na notebook přes Tailscale
vůbec dosáhne, ještě předtím, než to zkusí celý skript):

```bash
curl -i http://100.x.y.z:8787/health
curl -i -H "X-Proxy-Key: <token>" http://100.x.y.z:8787/
```

Pak test celého skriptu (nepushuje nic, jen ověří že to projde):

```bash
cd ~/zlonice-ted && git pull -q
. ~/zlonice-ted.env
node scripts/update-traffic.mjs
cat data/traffic.json   # čekej čerstvé "updated" a status:"ok"
```

Pokud sedí, spusť i s pushem (stejný vzor jako ostatní pipeline):

```bash
~/zlonice-ted/infra/do-pipelines/run-and-push.sh scripts/update-traffic.mjs data/traffic.json "Update traffic data"
```

## 7. Ať to přežije restart a spánek

Spusť jako administrátor:

```powershell
# Nikdy neusínat / nehibernovat při napájení ze sítě
powercfg -change -standby-timeout-ac 0
powercfg -change -hibernate-timeout-ac 0
powercfg -change -monitor-timeout-ac 0   # monitor může zhasnout, stroj běží dál

# Windows Update: pevná aktivní hodiny (6:00–23:00), ať neudělá noční
# "naslepo" restart s instalací aktualizací
New-Item -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "IsActiveHoursAuto" -Value 0 -Type DWord
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursStart" -Value 6 -Type DWord
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursEnd" -Value 23 -Type DWord
```

Aktivní hodiny jen omezují OKNO pro restart po instalaci (Windows i tak
nenutí restart hned) — pokud chceš mít jistotu úplně, zvaž ještě v
Nastavení → Windows Update → Rozšířené možnosti dočasně pozastavit
aktualizace na pár týdnů, než se tenhle provizorní obchvat ověří v praxi.

NSSM (krok 5) i Tailscale (jako služba, pokud je "unattended mode" zapnuté
z kroku 3) se po rebootu/probuzení spustí samy — restart notebooku tedy
obojí přežije, jen s pár minutami výpadku.

## 8. Ověření (shrnutí)

- `curl http://100.x.y.z:8787/` z dropletu bez tokenu → `401`
- `curl -H "X-Proxy-Key: ..." http://100.x.y.z:8787/` z dropletu → DATEX II XML (ne chyba)
- `data/traffic.json` na droplu/webu má čerstvé `updated` a `status:"ok"`
- Cron (`infra/do-pipelines/crontab.example`, řádek pro traffic) běží dál
  beze změny — jen teď skrz tenhle proxy místo napřímo/přes starý Worker.
