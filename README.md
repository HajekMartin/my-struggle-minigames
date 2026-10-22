# My Struggle minigames

Jednoduché české lobby pro 2–8 hráčů. Node.js v jednom procesu poskytuje frontend, HTTP API i Colyseus WebSockety na stejném portu. Lobby a rozehrané zápasy jsou v paměti; hráči, 24hodinové session a dokončené zápasy zůstávají v lokálním SQLite souboru.

## Spuštění

Vyžaduje Node.js **22.18 nebo novější** a npm. SQLite používá vestavěný modul `node:sqlite` (Node 22 při spuštění vypisuje upozornění na experimentální API).

```sh
npm ci
cp .env.example .env
npm run dev
```

Otevřete `http://localhost:3000`. Pro dva různé hráče použijte dva prohlížeče nebo běžné a anonymní okno. Karty sdílející cookie představují stejného hráče; nová karta převezme jeho připojení.

Vývojový příkaz přeloží frontend a sleduje změny serveru. Po změně souborů v `client/` spusťte `npm run build:client` a obnovte stránku.

Produkční spuštění:

```sh
npm run build
NODE_ENV=production npm start
```

Nastavení v `.env` nebo proměnných prostředí:

| Proměnná | Výchozí hodnota | Význam |
| --- | --- | --- |
| `PORT` | `3000` | Společný port HTTP a WebSocketů |
| `SQLITE_PATH` | `./data/lobby.sqlite` | Cesta k SQLite souboru; adresář se vytvoří automaticky |
| `NODE_ENV` | — | V HTTPS produkci nastavte `production`, aby cookie dostala příznak `Secure` a vývojová minihra nebyla dostupná |

Hosting musí podporovat dlouhodobě běžící **jeden Node.js proces a WebSockety**. V produkci použijte HTTPS proxy, která předává původní hlavičky Host a Origin a podporuje WebSocket upgrade. **SQLite soubor a jeho adresář potřebují trvalé, zapisovatelné úložiště** (SQLite vytváří také WAL soubory). Tabulky vzniknou automaticky. Restart serveru smaže všechny lobby, ale zachová hráče, platné session a dokončené výsledky. Rozehraný zápas se po restartu neobnovuje. Nespouštějte více instancí ani cluster, protože členství a lobby jsou v paměti procesu. Infrastruktura ani cloudové nasazení nejsou součástí projektu.

## Chování

- Zakladatel je správce lobby a může vyhodit ostatní hráče. Oprávnění ověřuje server podle session. Vyhození ihned odebere členství a resetuje ready všech; vyhozený hráč se automaticky nevrací, může ale ručně znovu zadat kód, pokud zápas neběží. Po odchodu správce přejde role na nejdéle přítomného zbývajícího hráče; při výpadku zůstává správci 30sekundová lhůta na návrat.
- Server generuje kód, ověřuje členství a povoluje pouze změnu vlastní připravenosti.
- Správce nastavuje počet kol; limit `MAX_ROUNDS` i výchozí hodnota jsou v `shared/config.ts`. Změna počtu kol, příchod nebo odebrání hráče resetuje ready všech. Alespoň dva připojení a připravení hráči automaticky spustí zápas. Konkrétní minihry vybírá server.
- Odpojený hráč zůstává 30 sekund v lobby, je nepřipravený a blokuje start. Reload i automatický návrat používají stejnou HttpOnly cookie. Lhůta začíná při zjištění výpadku serverem; neaktivní spojení kontroluje WebSocket heartbeat.
- Tlačítko „Opustit lobby“ odebere členství ihned. Prázdná lobby zanikne; pokud právě běží zápas, server ho nejprve dokončí a uloží i bez připojených hráčů. Nově vytvořená lobby bez dokončeného připojení zanikne po 15 sekundách.
- Během zápasu běží 30sekundová lhůta pro návrat dál, ale odpojení nezastavuje kola. Účastníci pro bodování zůstávají uzamčení i po opuštění, vyhození nebo vypršení lhůty. Vrátit se mohou pouze stávající členové do uplynutí této lhůty; noví hráči během zápasu nemohou vstoupit.
- Token se neposílá ve veřejném stavu ani neukládá do JavaScriptového úložiště. V SQLite je pouze SHA-256 hash kryptograficky náhodného tokenu; cookie má HttpOnly, SameSite=Lax a v produkci Secure. Jméno a veřejné ID nejsou důkaz identity.

## Zápas a minihry

Server řídí fáze pravidla → odpočet → minihra → výsledky kola → další kolo → celkové výsledky → stejná lobby s vynulovaným ready. Délky `RULES_MS`, `COUNTDOWN_MS`, `ROUND_RESULTS_MS` a `FINAL_RESULTS_MS` jsou v `server/match.ts`. Klient pouze zobrazuje společný serverový čas; přechody ani body nemůže potvrdit.

Pořadí se jednou sestaví zamícháním celého registru; po jeho vyčerpání následuje další zamíchání, bez stejné minihry na hranici dvou seznamů (pokud je jich více než jedna). Počet účastníků P se uzamkne při startu. Body jsou P−1 až 0; dělená místa dostanou průměr za obsazené pozice. Interní hodnota minihry je jen informativní. Každý účastník musí být ve výsledcích právě jednou. Neplatné výsledky se nepřičtou; pokud implementace selže, server bezpečně vyhodnotí všechny jako nedokončivší ve shodě. Výsledek každého kola i dokončení zápasu mají ochranu proti opakovanému zpracování.

`matches` v SQLite obsahuje jeden záznam na dokončený zápas: čas, lobby kód a JSON se snímkem účastníků, pořadím miniher, výsledky kol a konečným skóre. Jediný INSERT je atomický a ID zápasu je primární klíč. Historie nemá vlastní obrazovku ani API.

**Zatím nejsou implementovány skutečné minihry.** Pouze `NODE_ENV=development` registruje `development-test`. V produkci je seznam prázdný a ready všech zobrazí srozumitelnou chybu bez spuštění zápasu. Vývojový test se sám vyhodnotí po 5 sekundách; správce ho může ukončit dříve tlačítkem. První dva připojení účastníci sdílejí první místo, ostatní následují v pořadí účastníků; odpojení skončí společně jako nedokončivší.

Pro přidání minihry:

1. Implementujte `MinigameDefinition` z `server/minigames/types.ts` a přidejte ji do pole v `server/minigames/index.ts`. Povinné jsou ID, název, pravidla a konečný kladný `timeLimitMs`.
2. `create(context)` vytvoří jednu instanci pro kolo. `start()` zahájí vlastní logiku; `onMessage(playerId, data)` přijímá zprávy již ověřeného účastníka. `context.publish()` zveřejní JSON stavu. Budoucí vlastní vykreslení patří do klienta, nikoliv do společného bodování.
3. `context.complete()` požádá o předčasné ukončení. Při něm nebo při pevném serverovém limitu systém zavolá `finish()`. Vraťte seřazené skupiny `ResultGroup[]`: `{ players: [id1, id2], values: { [id1]: '12,3 s' } }` znamená dělené místo. Uveďte každého uzamčeného účastníka právě jednou; účastníky bez platného výsledku dejte do poslední skupiny s `unfinished: true`. Vlastní platný výsledek může přetrvat i po odpojení; rozhoduje konkrétní minihra.
4. `dispose()` musí zrušit všechny vlastní časovače, posluchače a další prostředky. Systém ho volá po vyhodnocení, při chybě a při zániku místnosti; svůj limit a přechodové časovače uklízí sám.

Herní zprávy mají obal `{ matchId, roundIndex, data }` a typ `minigame`; `roundIndex` se počítá od nuly. Zprávy ze staršího kola nebo zápasu se ignorují. Pouze vývojový test přijímá od správce `data: { action: 'finish', groups: [...] }` s předem určeným pořadím; tento vstup není součástí produkčních her. Úplný příklad ověření je v `tests/unit/match.test.ts`.

## Ověření

```sh
npx playwright install chromium
npm test
# Samostatně:
npm run typecheck
npm run test:unit
```

Testy nejprve ověří bodování včetně remíz a nedokončivších, validaci pořadí, zamíchané seznamy, ochranu před dvojím přičtením, staré callbacky, časové limity, úklid a oddělení vývojového registru od produkce. Potom spustí dočasný server na portu 3100 s oddělenou databází v `test-results/` a projdou aplikaci v oddělených browser kontextech. Ověřují dva hráče a ready, automatický start, reload se zachováním identity, převzetí druhou kartou bez duplicity, reset ready, automatický návrat po výpadku sítě a odebrání po 30 sekundách, mazání prázdné lobby, zákaz vstupu do spuštěné hry, kapacitu osmi hráčů, validaci jména, bezpečné zobrazení textu a atributy session cookie. Test správce ověřuje vyhození připojeného i odpojeného hráče, odmítnutí podvržené zprávy běžného hráče, zachování role při reloadu a předání role při odchodu. Průchod čtyř hráčů dvěma koly ověřuje výsledky, dělené vítězství, odchod hráče bez změny P, zápis do SQLite a návrat do stejné lobby. Další testy na portu 3101 ověřují prázdný produkční registr a zachování session a zánik lobby po restartu, hash tokenu v SQLite, expiraci session a produkční cookie Secure.

Ověřeno 22. 10. 2026: build i všechny testy úspěšně prošly v Chromiu. Cloudové nasazení ani provoz za skutečnou HTTPS proxy nebyly prováděny.

## Soubory

- `server/index.ts` — HTTP API, statické soubory a start Colyseus.
- `server/auth.ts` — SQLite, hráči a session cookie.
- `server/lobby.ts` — místnosti, členství, nastavení a start zápasu.
- `server/match.ts`, `server/scoring.ts` — fáze zápasu, výběr a společné body.
- `server/minigames/` — rozhraní, registr a vývojový test.
- `server/history.ts` — uložení dokončených zápasů.
- `client/` — HTML, CSS a TypeScript bez frameworku.
- `shared/` — veřejné typy zpráv a limit počtu kol.
- `tests/` — průchod skutečným prohlížečem a ověření session po restartu.
