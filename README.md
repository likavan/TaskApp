# ⏱️ TaskApp

Jednoduchá webová aplikácia na **rýchle prepínanie práce na projektoch** a sledovanie času.
Náhrada za ťažkopádne prepínanie v Kimai — prepnutie na iný projekt je na **jeden klik**
(alebo klávesovú skratku), ku každému záznamu sa dá rýchlo pridať poznámka a hneď vidíš
prehľad odpracovaného času aj históriu.

## Vlastnosti

- **Prepnutie jedným klikom** — klik na projekt zastaví bežiaci časovač a spustí nový.
- **Klávesové skratky** — `1`–`9` prepnú na projekt, `S` zastaví.
- **Poznámka k záznamu** — napíš na čom pracuješ; dá sa upraviť aj počas behu.
- **Živý časovač** aktuálne bežiaceho projektu.
- **Prehľad času** za dnes / tento týždeň (súčet na projekt).
- **História** záznamov s možnosťou úpravy poznámky a mazania.
- **Naposledy použité projekty** navrchu.
- Bez závislosti na Kimai, dáta v lokálnej SQLite databáze.

## Technológie

- **Frontend:** čisté HTML/CSS/JS (žiadny framework, žiadny build)
- **Backend — dve rovnocenné verzie s identickým API:**
  - **Node.js + Express** (`server.js`) — lokálny beh a Vercel; SQLite cez
    `@libsql/client` (lokálne súbor v `data/`, na Verceli [Turso](https://turso.tech))
  - **PHP** (`public/api.php`) — klasický zdieľaný hosting (napr. Websupport);
    SQLite súbor priamo na hostingu, konfigurácia v `config.php`.
    Návod: [NASADENIE-WEBSUPPORT.md](NASADENIE-WEBSUPPORT.md)

## Spustenie

Vyžaduje Node.js 18+.

```bash
npm install
npm start
```

Aplikácia beží na `http://localhost:3000`.

Vývojový režim s automatickým reštartom:

```bash
npm run dev
```

## Konfigurácia

| Premenná             | Popis                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `PORT`               | Port servera (predvolene `3000`).                                        |
| `APP_PASSWORD`       | Ak je nastavená, zapne sa jednoduchá ochrana heslom (prihlásenie).       |
| `TURSO_DATABASE_URL` | URL Turso databázy (`libsql://…`). Ak nie je nastavená, použije sa lokálny súbor `data/taskapp.db`. |
| `TURSO_AUTH_TOKEN`   | Auth token k Turso databáze.                                             |
| `KIMAI_URL`          | URL Kimai inštancie (napr. `https://kimai.firma.sk`). Zapne živé zrkadlenie do Kimai. |
| `KIMAI_API_TOKEN`    | API token z Kimai (profil → API Access).                                 |
| `KIMAI_TIMEZONE`     | Časové pásmo pre zápis do Kimai (predvolene `Europe/Bratislava`).        |

Príklad s ochranou heslom:

```bash
APP_PASSWORD=tajneheslo PORT=8080 npm start
```

Databáza sa vytvorí automaticky v priečinku `data/` (je v `.gitignore`).

## Nasadenie na Vercel

Vercel je serverless — lokálny súbor SQLite by sa strácal, preto sa v produkcii
používa [Turso](https://turso.tech) (hostovaný SQLite, má free tier). Kód je rovnaký,
prepína sa len env premennou.

1. **Vytvor Turso databázu** ([turso.tech](https://turso.tech) → účet zdarma):

   ```bash
   # nainštaluj Turso CLI: https://docs.turso.tech/cli/installation
   turso db create taskapp
   turso db show taskapp --url          # → TURSO_DATABASE_URL
   turso db tokens create taskapp       # → TURSO_AUTH_TOKEN
   ```

2. **Naimportuj projekt do Vercelu** ([vercel.com/new](https://vercel.com/new) → vyber tento
   GitHub repozitár; framework preset nechaj **Other**, žiadny build command netreba).

3. **Nastav environment premenné** v projekte na Verceli
   (Settings → Environment Variables):

   - `TURSO_DATABASE_URL` = `libsql://…` (z kroku 1)
   - `TURSO_AUTH_TOKEN` = token (z kroku 1)
   - `APP_PASSWORD` = tvoje heslo — **odporúčané**, appka bude verejne dostupná na internete

4. **Deploy** — Vercel nasadí `api/index.js` ako serverless funkciu (celé Express API)
   a `public/` servíruje ako statické súbory. Ďalšie pushe na hlavnú vetvu sa nasadzujú
   automaticky.

Alternatíva bez Turso: hosting s trvalým diskom (Fly.io, Railway, Render) — tam appka
beží ako obyčajný Node proces a stačí lokálny SQLite súbor, bez ďalšej konfigurácie.

## Prepojenie s Kimai (voliteľné)

Ak nastavíš `KIMAI_URL` a `KIMAI_API_TOKEN`, TaskApp živo zrkadlí záznamy do
[Kimai 2](https://www.kimai.org) cez jeho REST API:

1. V editácii projektu (⚙) sa objaví výber **Kimai projekt** a **aktivita** —
   namapuj TaskApp projekt na Kimai.
2. Prepnutie/stop namapovaného projektu vytvorí/ukončí timesheet v Kimai;
   úprava časov či poznámky a zmazanie záznamu sa prenesú tiež.
3. Keď Kimai nie je dostupné, TaskApp funguje ďalej — akcia sa vykoná lokálne
   a appka len zobrazí „⚠ Kimai sync zlyhal".

Neprepojené projekty sa do Kimai neposielajú.

## Ako to funguje

V danom čase beží **najviac jeden** časový záznam. Prepnutie na iný projekt v jednej
transakcii zastaví aktuálny záznam (nastaví čas konca) a založí nový pre cieľový projekt.

## REST API (prehľad)

| Metóda   | Cesta                     | Popis                                        |
| -------- | ------------------------- | -------------------------------------------- |
| `GET`    | `/api/projects`           | Zoznam projektov (podľa naposledy použitých) |
| `POST`   | `/api/projects`           | Vytvor projekt                               |
| `PATCH`  | `/api/projects/:id`       | Uprav projekt (názov, farba, archivácia)     |
| `DELETE` | `/api/projects/:id`       | Zmaž projekt                                 |
| `GET`    | `/api/state`              | Aktuálne bežiaci záznam                       |
| `POST`   | `/api/switch`             | Prepni na projekt (`{ projectId, note }`)    |
| `POST`   | `/api/stop`               | Zastav sledovanie                            |
| `GET`    | `/api/entries?range=`     | História (`today` / `week`)                  |
| `PATCH`  | `/api/entries/:id`        | Uprav záznam                                 |
| `DELETE` | `/api/entries/:id`        | Zmaž záznam                                  |
| `GET`    | `/api/summary?range=`     | Súčet času na projekt (`today` / `week`)     |
