# Nasadenie TaskApp na Websupport (zdieľaný hosting)

TaskApp má dva rovnocenné backendy: Node.js (Vercel) a **PHP** (`public/api.php`)
pre klasický zdieľaný hosting. Frontend je identický. PHP verzia ukladá dáta do
SQLite súboru priamo na hostingu — žiadna externá databáza, všetko máš u seba.

## Požiadavky

- PHP **8.1 alebo novšie** (nastavíš vo Websupport admine → PHP verzia)
- Rozšírenia `pdo_sqlite` a `curl` (na Websupporte štandardne zapnuté)

## Postup

1. **Nahraj súbory** — celý obsah priečinka `public/` z tohto repozitára nahraj
   do web priečinka hostingu (cez FTP alebo File manager vo Websupport admine):

   ```
   index.html
   app.js
   styles.css
   api.php
   .htaccess          ← dôležité, nezabudni (skrytý súbor!)
   config.example.php
   manifest.webmanifest
   icon-192.png, icon-512.png, apple-touch-icon.png
   ```

   Odporúčam nasadiť na subdoménu (napr. `taskapp.tvojadomena.sk`) —
   appka očakáva, že beží v koreňovom adresári domény.

2. **Vytvor konfiguráciu** — skopíruj `config.example.php` ako `config.php`
   a vyplň:

   ```php
   return [
       'APP_PASSWORD' => 'tvoje-silne-heslo',   // odporúčané!
       'KIMAI_URL' => '',                        // voliteľné (Kimai zrkadlenie)
       'KIMAI_API_TOKEN' => '',
       'KIMAI_TIMEZONE' => 'Europe/Bratislava',
   ];
   ```

3. **Hotovo.** Otvor doménu v prehliadači — appka si sama vytvorí priečinok
   `data/` s SQLite databázou (a ochráni ho pred stiahnutím zvonka).
   Prihlás sa heslom a používaj.

## Zálohovanie

Celá databáza je jeden súbor: `data/taskapp.db`. Stačí si ho občas stiahnuť
cez FTP (ideálne keď appka práve nebeží, alebo aj tak — SQLite to zvládne).

## Riešenie problémov

- **Biela stránka / chyba 500** — skontroluj PHP verziu (8.1+) a či sa nahral
  `.htaccess` (FTP klienti skryté súbory občas preskočia).
- **„Nepodarilo sa vytvoriť priečinok data/"** — daj web priečinku práva na
  zápis (na Websupporte býva v poriadku automaticky).
- **Kimai sync zlyhal** — over `KIMAI_URL` (musí byť dostupná z internetu)
  a platnosť API tokenu.
