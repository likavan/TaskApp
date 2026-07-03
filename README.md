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

- **Backend:** Node.js + Express
- **Databáza:** SQLite (`better-sqlite3`) — jeden súbor v `data/`, žiadna konfigurácia
- **Frontend:** čisté HTML/CSS/JS (žiadny framework, žiadny build)

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

| Premenná       | Popis                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `PORT`         | Port servera (predvolene `3000`).                                     |
| `APP_PASSWORD` | Ak je nastavená, zapne sa jednoduchá ochrana heslom (prihlásenie).    |

Príklad s ochranou heslom:

```bash
APP_PASSWORD=tajneheslo PORT=8080 npm start
```

Databáza sa vytvorí automaticky v priečinku `data/` (je v `.gitignore`).

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
