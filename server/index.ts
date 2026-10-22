import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { Server, matchMaker, createRouter } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createPlayer, findSession, sameOrigin } from './auth.js';
import { LobbyRoom, creationKey, roomByPlayer, roomsByCode } from './lobby.js';

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: 'Požadavek z jiné stránky není povolen.' });
    return;
  }
  next();
});
app.use(express.json({ limit: '2kb' }));
app.get('/api/me', (req, res) => {
  const session = findSession(req.headers.cookie);
  res.json({ player: session ? { id: session.id, name: session.name } : null, lobbyCode: session ? roomByPlayer.get(session.id)?.code ?? null : null });
});
app.post('/api/player', (req, res) => {
  const existing = findSession(req.headers.cookie);
  if (existing) { res.json({ player: { id: existing.id, name: existing.name } }); return; }
  try {
    const { player, cookie } = createPlayer(req.body?.name);
    res.setHeader('Set-Cookie', cookie);
    res.status(201).json({ player });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

const pending = new Set<string>();
app.post('/api/lobby', async (req, res) => {
  const session = findSession(req.headers.cookie);
  if (!session) { res.status(401).json({ error: 'Platnost přihlášení vypršela. Obnovte stránku a zadejte jméno.' }); return; }
  if (pending.has(session.id)) { res.status(409).json({ error: 'Připojení už probíhá. Zkuste to znovu.' }); return; }
  pending.add(session.id);
  try {
    let room = roomByPlayer.get(session.id);
    if (req.body?.action === 'join') {
      const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      const target = roomsByCode.get(code);
      if (!target) { res.status(404).json({ error: 'Lobby s tímto kódem neexistuje.' }); return; }
      target.checkJoin(session.id);
      room = target;
    } else if (req.body?.action === 'create') {
      if (!room) {
        const listing = await matchMaker.createRoom('lobby', { creationKey, adminId: session.id });
        room = [...roomsByCode.values()].find(candidate => candidate.roomId === listing.roomId)!;
      }
    } else if (req.body?.action !== 'resume' || !room) {
      res.status(404).json({ error: 'Původní lobby už neexistuje. Vytvořte novou nebo zadejte kód.' }); return;
    }
    room.checkJoin(session.id);
    // The reservation carries no player identity. onAuth reads the actual WebSocket cookie.
    const seat = await matchMaker.joinById(room.roomId, {});
    res.json({ seat });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  } finally { pending.delete(session.id); }
});

app.use(express.static(resolve('dist/public'), { index: 'index.html' }));
const errors: ErrorRequestHandler = (_error, _req, res, _next) => res.status(400).json({ error: 'Neplatný požadavek.' });
app.use(errors);
const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 1_000,
    pingMaxRetries: 2,
    beforeUpgrade: context => {
      if (!sameOrigin(context.headers.get('origin') ?? undefined, context.headers.get('host') ?? undefined)) return new Response('Forbidden', { status: 403 });
      if (!findSession(context.headers.get('cookie') ?? undefined)) return new Response('Unauthorized', { status: 401 });
    }
  }),
  greet: false
});
// The browser only uses our cookie-authenticated API for seat reservations.
// Do not expose Colyseus' generic public create/join/reconnect HTTP endpoints.
gameServer.router = createRouter({}, {
  onRequest: request => new URL(request.url).pathname.startsWith('/matchmake/')
    ? Response.json({ error: 'Použijte rozhraní lobby.' }, { status: 404 })
    : undefined
});
gameServer.define('lobby', LobbyRoom);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT musí být číslo 1–65535.');
await gameServer.listen(port);
console.log(`Lobby běží na http://localhost:${port}`);
