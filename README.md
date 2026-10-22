# My Struggle minigames

Jednoduché české lobby pro 2–8 hráčů. Node.js v jednom procesu poskytuje frontend, HTTP API i Colyseus WebSockety na stejném portu. Lobby jsou pouze v paměti; hráči a 24hodinové session zůstávají v lokálním SQLite souboru.

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
npm start
```

Nastavení v `.env` nebo proměnných prostředí:

| Proměnná | Výchozí hodnota | Význam |
| --- | --- | --- |
| `PORT` | `3000` | Společný port HTTP a WebSocketů |
| `SQLITE_PATH` | `./data/lobby.sqlite` | Cesta k SQLite souboru; adresář se vytvoří automaticky |
| `NODE_ENV` | — | V HTTPS produkci nastavte `production`, aby cookie dostala příznak `Secure` |

Hosting musí podporovat dlouhodobě běžící **jeden Node.js proces a WebSockety**. V produkci použijte HTTPS proxy, která předává původní hlavičky Host a Origin a podporuje WebSocket upgrade. **SQLite soubor a jeho adresář potřebují trvalé, zapisovatelné úložiště** (SQLite vytváří také WAL soubory). Tabulky vzniknou automaticky. Restart serveru smaže všechny lobby, ale zachová hráče a platné session. Nespouštějte více instancí ani cluster, protože členství a lobby jsou v paměti procesu. Infrastruktura ani cloudové nasazení nejsou součástí projektu.

## Chování

- Zakladatel je správce lobby a může vyhodit ostatní hráče. Oprávnění ověřuje server podle session. Vyhození ihned odebere členství a resetuje ready všech; vyhozený hráč se automaticky nevrací, může ale ručně znovu zadat kód. Po odchodu správce přejde role na nejdéle přítomného zbývajícího hráče; při výpadku zůstává správci 30sekundová lhůta na návrat.
- Server generuje kód, ověřuje členství a povoluje pouze změnu vlastní připravenosti.
- Příchod nebo odebrání hráče resetuje připravenost všech. Alespoň dva připojení a připravení hráči automaticky spustí hru; zatím se zobrazí pouze „Hra spuštěna“.
- Odpojený hráč zůstává 30 sekund v lobby, je nepřipravený a blokuje start. Reload i automatický návrat používají stejnou HttpOnly cookie. Lhůta začíná při zjištění výpadku serverem; neaktivní spojení kontroluje WebSocket heartbeat.
- Tlačítko „Opustit lobby“ odebere hráče ihned. Prázdná lobby zanikne. Nově vytvořená lobby bez dokončeného připojení zanikne po 15 sekundách.
- Do spuštěné hry se mohou vracet její stávající členové, noví hráči už ne.
- Token se neposílá ve veřejném stavu ani neukládá do JavaScriptového úložiště. V SQLite je pouze SHA-256 hash kryptograficky náhodného tokenu; cookie má HttpOnly, SameSite=Lax a v produkci Secure. Jméno a veřejné ID nejsou důkaz identity.

## Ověření

```sh
npx playwright install chromium
npm test
```

Testy provedou build, spustí dočasný server na portu 3100 s oddělenou databází v `test-results/` a projdou aplikaci v oddělených browser kontextech. Ověřují dva hráče a ready, automatický start, reload se zachováním identity, převzetí druhou kartou bez duplicity, reset ready, automatický návrat po výpadku sítě a odebrání po 30 sekundách, mazání prázdné lobby, zákaz vstupu do spuštěné hry, kapacitu osmi hráčů, validaci jména, bezpečné zobrazení textu a atributy session cookie. Test správce ověřuje vyhození připojeného i odpojeného hráče, odmítnutí podvržené zprávy běžného hráče, zachování role při reloadu a předání role při odchodu. Další test na portu 3101 ověřuje zachování session a zánik lobby po restartu, hash tokenu v SQLite, expiraci session a produkční cookie Secure.

Ověřeno 22. 10. 2026: build i všechny testy úspěšně prošly v Chromiu. Cloudové nasazení ani provoz za skutečnou HTTPS proxy nebyly prováděny.

## Soubory

- `server/index.ts` — HTTP API, statické soubory a start Colyseus.
- `server/auth.ts` — SQLite, hráči a session cookie.
- `server/lobby.ts` — místnosti, členství a pravidla lobby.
- `client/` — HTML, CSS a TypeScript bez frameworku.
- `shared/types.ts` — veřejné typy zpráv.
- `tests/` — průchod skutečným prohlížečem a ověření session po restartu.
