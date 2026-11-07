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

Implementované jsou **Závod aut** (`car-race`) a **Bazukový souboj** (`worms`). Závod je nyní dočasně vyřazen z běžného výběru kvůli testování souboje; zapíná se přes `enabled` v `shared/minigames.config.ts`. Testovací minihra `development-test` se načte pouze při současném `NODE_ENV=development` a `MINIGAME_TEST_ONLY=1`; v tomto režimu nahrazuje celý běžný registr. Běžný vývoj i produkce vybírají jen skutečné minihry. Hráči si minihry nevybírají; o pořadí rozhoduje server. Vývojový test se sám vyhodnotí po 5 sekundách; správce ho může ukončit dříve tlačítkem. První dva připojení účastníci sdílejí první místo, ostatní následují v pořadí účastníků; odpojení skončí společně jako nedokončivší.

V `shared/minigames.config.ts` je společná konfigurace všech skutečných miniher. Každá má `enabled` a vlastní herní parametry (rychlosti, drift, životy, staminu, poškození a časové limity). Výchozí stav je závod vypnutý, souboj zapnutý. Pokud vypnete všechny hry, server při pokusu o start zobrazí chybu. Po změně konfigurace proveďte build a restart serveru; při vývoji znovu spusťte `npm run dev`, aby se nastavení promítlo i do klienta.

Pro přidání minihry:

1. Implementujte `MinigameDefinition` z `server/minigames/types.ts` a přidejte ji do pole v `server/minigames/index.ts`. Povinné jsou ID, název, pravidla a konečný kladný `timeLimitMs`.
2. `create(context)` vytvoří jednu instanci při zobrazení pravidel. Volitelné `prepare()` připraví prostředí před společným odpočtem. `start()` zahájí vlastní logiku až po odpočtu; `onMessage(playerId, data)` přijímá zprávy již ověřeného účastníka. `context.publish()` zveřejní celý JSON stavu, `context.update()` odešle jen měnící se část a zároveň udržuje úplný snímek pro obnovení stránky. Volitelné `onDisconnect(playerId)` přijme odpojení ihned; běžná pravidla lobby tím nejsou změněna. Budoucí vlastní vykreslení patří do klienta, nikoliv do společného bodování.
3. `context.complete()` požádá o předčasné ukončení. Při něm nebo při pevném serverovém limitu systém zavolá `finish()`. Vraťte seřazené skupiny `ResultGroup[]`: `{ players: [id1, id2], values: { [id1]: '12,3 s' } }` znamená dělené místo. Uveďte každého uzamčeného účastníka právě jednou; nedokončivší označte `unfinished: true` a zařaďte je za dokončivší. Pokud mají platný postup, mohou mít různá umístění; účastníky bez platného výsledku dejte do společné poslední skupiny. Vlastní platný výsledek může přetrvat i po odpojení; rozhoduje konkrétní minihra.
4. `dispose()` musí zrušit všechny vlastní časovače, posluchače a další prostředky. Systém ho volá po vyhodnocení, při chybě a při zániku místnosti; svůj limit a přechodové časovače uklízí sám.

Herní zprávy mají obal `{ matchId, roundIndex, data }` a typ `minigame`; `roundIndex` se počítá od nuly. Zprávy ze staršího kola nebo zápasu se ignorují. Pouze vývojový test přijímá od správce `data: { action: 'finish', groups: [...] }` s předem určeným pořadím; tento vstup není součástí produkčních her. Úplný příklad ověření je v `tests/unit/match.test.ts`.

## Závod aut

- Phaser 3 běží pouze v prohlížeči a načítá se až při závodu. Planck 1.4.2 počítá fyziku na Node.js serveru (tato verze zachovává podporu Node.js 22). Grafika používá geometrické tvary; žádné externí obrázky ani zvuk.
- `shared/minigames.config.ts` obsahuje přehledné parametry závodu: cílových 180 s × běžných 24 m/s = přibližně 4320 m, limit 300 s, šířku 22 m, vlastnosti aut, 60Hz fyziku, 20Hz snímky a 2sekundový zámek po resetu. Závod vyplňuje celé okno prohlížeče a přizpůsobuje se změně jeho velikosti; pořadí, čas a ovládání jsou přes hrací plochu. Kamera ukazuje prostor před autem.
- Skupinu drží pohromadě server podle skutečného postupu po trati. Dohánění přidává od odstupu 15 do 60 m plynule až 35 % k dopřednému zrychlení a maximální rychlosti. Aktivní auta více než 35 m před posledním aktivním autem zároveň postupně zpomalují; při 75 m má zpomalení největší účinek (až na 50 % běžné rychlosti). Jde o měkké omezení rozestupu bez přesouvání aut. Závodník se pro zpomalování skupiny počítá až po 15 m postupu, s ovládáním a skutečným novým postupem alespoň 1 m během posledních 6 s. AFK na startu, neutrální síťové zprávy ani držený plyn proti bariéře skupinu trvale nebrzdí. Odpojení a dokončivší ji také nezpomalují. Parametry jsou v `shared/minigames.config.ts`; klient používá stejný násobek pro predikci.
- Při rychlém zatáčení klesá boční přilnavost pro výraznější drift. Po narovnání řízení se opět zvýší a auto se stabilizuje; fyzika zůstává společná pro server a predikci.
- Trať vznikne před odpočtem na serveru z rovin a pozvolných oblouků. Monotónní směr a omezená křivost zabraňují návratům přes sebe; polygon bariér se kontroluje na překřížení. Po nejvýše osmi pokusech je zálohou rovná trať. Všichni dostanou stejný popis; startovní místa se náhodně rozdělí bez překryvů.
- **WASD nebo šipky:** plyn, brzda/zpátečka a řízení. Ztráta focusu vynuluje vstupy a server navíc neutralizuje vstup starší než 300 ms. Samotný blur není odpojení. **R:** návrat za poslední bezpečný checkpoint, vynulování rychlosti a 2 s bez ovládání. Návrat nikdy nezvýší postup a hledá volné místo mimo ostatní auta; není-li volné, čeká. Před startem jsou vstupy zablokované.
- Klient posílá pouze vstupy se sekvencí. Server řeší nárazy, bariéry, průjezd checkpointy i cíl správným směrem. Vlastní auto používá jednoduchou predikci s opakováním nepotvrzených vstupů a opravou ze serveru; ostatní auta se interpolují s malým zpožděním. Rychlé snímky se posílají samostatně, bez opakovaného přenosu celé tratě a bez překreslování lobby.
- Odpojení (včetně reloadu, pokud ho server zaznamená jako přerušení) ihned vyloučí účastníka z tohoto závodu a odstraní jeho auto. Návrat do 30 s zachovává členství v lobby, ale hráč pouze sleduje. Platný dojezd zůstane zachovaný i po odpojení. V příští minihře může znovu hrát.
- Závod skončí po dojezdu všech zbývajících aut, okamžitě bez zbývajících závodníků, nebo po 300 s. Pořadí: čas dojezdu → připojení nedokončivší podle checkpointů a vzdálenosti po úseku → vyloučení ve shodě na posledním místě. Postup není vzdušná vzdálenost k cíli. Hodnoty v sekundách a procentech jsou informativní; body přiděluje původní společný systém.
- Na konci se uklidí interval, fyzikální svět, klávesnice i Phaser scéna. Lobby, odpočet, výsledky, celkové skóre i SQLite historie používají stávající systém.

## Bazukový souboj

- Parametry jsou v `shared/minigames.config.ts`: 100 životů, stamina 160 pixelů pohybu, skok za 32 staminy, tah 25 s, souboj 300 s, jeden výstřel za tah. Náhodné pořadí tahů se během souboje nemění, vyřazení se přeskakují.
- A/D nebo šipky pohybují postavou, mezerník skáče. Myš určuje směr, podržení levého tlačítka nabíjí až 1,5 s a uvolnění vystřelí. Stamina se během tahu neobnovuje; s prázdnou staminou lze mířit a střílet. Tlačítko „Ukončit tah“ předá tah po ustálení postav. Při ztrátě focusu se vstupy i nabíjení zruší.
- Server generuje kopce a bezpečné starty. Terén tvoří sloupce s intervaly pevné hmoty; kruhový kráter odebere stejné intervaly pro obraz i kolize, včetně děr pod převisy. Jednoduchou fyziku postav a balistiku počítá server v pevném kroku 60 Hz; stav odesílá 15× za sekundu. Phaser zobrazuje celou mapu v okně bez dalších závislostí.
- Bazuka má gravitaci bez větru, výbuch o poloměru 68 px a maximálním poškození 60, které klesá se vzdáleností. Poškozuje i střelce, odhazuje a ničí podloží. Projektil kontroluje cestu po nejvýše 2 px, takže nepřeskočí tenkou překážku; smí explodovat jen jednou.
- Další tah počká na dopad a pády. Let projektilu má limit 6 s, celé účinky nejvýše 12 s. Při bezpečnostním limitu server dokončí výbuch a usadí zbytek postav na podloží nebo vyhodnotí pád do vody. Po 300 s nové tahy nevzniknou, poslední výstřel a účinky se dokončí. Společný bezpečnostní časovač ponechává pouze rezervu na toto dokončení.
- Voda a opuštění mapy vyřazují. Živá postava po odpojení ihned zmizí a dostane sdílené poslední místo s dalšími odpojenými; návrat dovolí jen sledování. Již dosažený výsledek mrtvé postavy se odpojením nemění.
- Pořadí: přeživší (při časovém limitu podle životů), potom později vyřazení před dříve vyřazenými a nakonec odpojení. Výbuch a jeho následné pády tvoří jednu skupinu vyřazení; poslední současně zahynuvší sdílejí první místo. Shodné životy také znamenají dělené místo. Body a následný průběh zápasu řeší původní systém.
- Na konci se zruší interval, stav fyziky, nabíjení, posluchače vstupů a Phaser scéna. Žádná rozehraná data se neobnovují po restartu.

## Ověření

```sh
npx playwright install chromium
npm test
# Samostatně:
npm run typecheck
npm run test:unit
```

Testy nejprve ověří bodování včetně remíz a nedokončivších, validaci pořadí, zamíchané seznamy, ochranu před dvojím přičtením, staré callbacky, časové limity, úklid a oddělení vývojového registru od produkce. Potom spustí dočasný server na portu 3100 s oddělenou databází v `test-results/` a projdou aplikaci v oddělených browser kontextech. Ověřují dva hráče a ready, automatický start, reload se zachováním identity, převzetí druhou kartou bez duplicity, reset ready, automatický návrat po výpadku sítě a odebrání po 30 sekundách, mazání prázdné lobby, zákaz vstupu do spuštěné hry, kapacitu osmi hráčů, validaci jména, bezpečné zobrazení textu a atributy session cookie. Test správce ověřuje vyhození připojeného i odpojeného hráče, odmítnutí podvržené zprávy běžného hráče, zachování role při reloadu a předání role při odchodu. Průchod čtyř hráčů dvěma koly ověřuje výsledky, dělené vítězství, odchod hráče bez změny P, zápis do SQLite a návrat do stejné lobby. Další testy na portu 3101 ověřují skutečnou minihru bez vývojového testu v produkčním registru a zachování session a zánik lobby po restartu, hash tokenu v SQLite, expiraci session a produkční cookie Secure.

Závodní testy kontrolují generátor včetně náhradní tratě, průjezd plné tratě ve zrychlené serverové simulaci, checkpointy, nárazy a bariéry, reset, pořadí po odpojení a omezenou pomoc při dohánění včetně skutečného zmenšování odstupu. Samostatný závod na portu 3103 ověřuje ve dvou browser kontextech společný start, rozměry hrací plochy přes celé okno i po změně velikosti, skutečný vzájemný náraz, R, blur, vyloučení a opětovné připojení jako divák. Regresní lobby testy používají výhradně v development proměnnou `MINIGAME_TEST_ONLY=1`, aby jejich krátké zápasy zůstaly deterministické; produkce ji ignoruje.

Soubojové testy ověřují tahy, cizí vstupy, staminu a skok, jeden výstřel, sílu měřenou serverem, zásahy tenkého terénu, krátery a pády, remízy nezávislé na pořadí zpracování, odpojení, oba časové limity a úklid. Test na portu 3104 prochází ve dvou nezávislých kontextech společný start, skutečný pohyb a skok, nabíjení a střelbu myší, poškození a kráter, předání tahu, odpojení, společné výsledky a zápis do SQLite. Závodní a soubojový browser test omezují registr pouze ve svém spouštěcím skriptu; aplikace nemá volbu hry ani testovací API.

Ověřeno 22. 10. 2026: TypeScript, build, jednotkové testy i testy v Chromiu. Cloudové nasazení ani provoz za skutečnou HTTPS proxy nebyly prováděny.

## Soubory

- `server/index.ts` — HTTP API, statické soubory a start Colyseus.
- `server/auth.ts` — SQLite, hráči a session cookie.
- `server/lobby.ts` — místnosti, členství, nastavení a start zápasu.
- `server/match.ts`, `server/scoring.ts` — fáze zápasu, výběr a společné body.
- `server/minigames/` — rozhraní, registr, vývojový test a serverový závod v `race/` a souboj v `worms/`.
- `shared/minigames.config.ts` — zapínání a parametry všech skutečných miniher.
- `shared/race.ts`, `client/race.ts` — protokol závodu, predikce a Phaser vykreslení.
- `shared/worms.ts`, `client/worms.ts` — veřejný stav a Phaser vykreslení souboje.
- `server/history.ts` — uložení dokončených zápasů.
- `client/` — HTML, CSS a TypeScript bez frameworku.
- `shared/` — veřejné typy zpráv a limit počtu kol.
- `tests/` — průchod skutečným prohlížečem a ověření session po restartu.
