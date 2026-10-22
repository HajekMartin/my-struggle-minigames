import Phaser from 'phaser';
import type { JsonValue, MatchPhase } from '../shared/types.js';
import { NEUTRAL_INPUT, RACE, angleDifference, clamp, pointAt, predictMotion,
  type CarMotion, type DriveInput, type RaceCarState, type RaceData, type RaceSnapshot } from '../shared/race.js';

const SCALE = 8;
const INTERPOLATION_MS = 100;
const element = (id: string) => document.getElementById(id)!;
type Visual = { car: Phaser.GameObjects.Container; name: Phaser.GameObjects.Text };

export class RaceView {
  private game: Phaser.Game;
  private scene?: Phaser.Scene;
  private visuals = new Map<string, Visual>();
  private frames: { snapshot: RaceSnapshot; receivedAt: number }[] = [];
  private latest: RaceSnapshot;
  private phase: MatchPhase;
  private keys = new Set<string>();
  private focused = true;
  private resetRequested = false;
  private seq = 0;
  private prediction?: CarMotion;
  private shown?: CarMotion;
  private pending: DriveInput[] = [];
  private resetSerial = -1;
  private accumulator = 0;
  private destroyed = false;
  private cameraReady = false;

  constructor(private data: RaceData, phase: MatchPhase, private ownId: string, private send: (data: JsonValue) => void) {
    this.latest = data.snapshot; this.phase = phase;
    const owner = this;
    class RacingScene extends Phaser.Scene {
      constructor() { super('race'); }
      create() { owner.createScene(this); }
      update(_time: number, delta: number) { owner.update(delta); }
    }
    this.game = new Phaser.Game({
      type: Phaser.CANVAS, parent: element('race-canvas'), width: element('race-canvas').clientWidth || window.innerWidth, height: element('race-canvas').clientHeight || window.innerHeight,
      backgroundColor: '#111111', banner: false, autoFocus: false,
      scale: { mode: Phaser.Scale.RESIZE }, scene: RacingScene,
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      render: { antialias: true }
    });
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    window.addEventListener('focus', this.focus);
    document.addEventListener('visibilitychange', this.visibility);
    this.ingest(data.snapshot, phase);
  }

  private relevant(event: KeyboardEvent) {
    return ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR'].includes(event.code) &&
      !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement);
  }
  private keyDown = (event: KeyboardEvent) => {
    if (!this.relevant(event)) return;
    event.preventDefault();
    this.keys.add(event.code);
    if (event.code === 'KeyR' && !event.repeat) this.resetRequested = true;
  };
  private keyUp = (event: KeyboardEvent) => { if (this.relevant(event)) { event.preventDefault(); this.keys.delete(event.code); } };
  private blur = () => { this.focused = false; this.neutral(); };
  private focus = () => { this.focused = true; };
  private visibility = () => { if (document.hidden) this.blur(); };
  private neutral() {
    this.keys.clear(); this.resetRequested = false;
    if (this.phase === 'playing') this.send({ ...NEUTRAL_INPUT, seq: ++this.seq });
  }

  ingest(snapshot: RaceSnapshot, phase: MatchPhase) {
    if (this.destroyed) return;
    this.phase = phase; this.latest = snapshot;
    const receivedAt = performance.now();
    this.frames.push({ snapshot, receivedAt });
    this.frames = this.frames.slice(-8);
    const own = snapshot.cars.find(c => c.id === this.ownId);
    if (own) {
      this.seq = Math.max(this.seq, own.ack);
      if (this.resetSerial !== own.resetSerial || own.status !== 'racing' || own.lockedUntil > snapshot.elapsedMs || own.resetPending) {
        this.prediction = { ...own }; this.shown = { ...own }; this.pending = [];
      } else {
        this.pending = this.pending.filter(input => input.seq > own.ack).slice(-120);
        this.prediction = { ...own };
        for (const input of this.pending) this.prediction = predictMotion(this.prediction, input, 1 / RACE.physicsHz, own.catchupBoost);
      }
      this.resetSerial = own.resetSerial;
    }
    this.renderHud();
  }

  private createScene(scene: Phaser.Scene) {
    this.scene = scene;
    const canvas = scene.game.canvas;
    canvas.setAttribute('aria-label', 'Závod aut z pohledu shora. Ovládání WASD nebo šipkami, R vrací auto za checkpoint.');
    canvas.setAttribute('role', 'img');
    const track = this.data.track;
    const road = scene.add.graphics();
    road.fillStyle(0x303033, 1);
    road.beginPath();
    const polygon = [...track.left, ...[...track.right].reverse()];
    polygon.forEach((p, i) => i ? road.lineTo(p.x * SCALE, p.y * SCALE) : road.moveTo(p.x * SCALE, p.y * SCALE));
    road.closePath(); road.fillPath();
    road.lineStyle(3, 0xdddddd, 1);
    for (const side of [track.left, track.right]) { road.beginPath(); side.forEach((p, i) => i ? road.lineTo(p.x * SCALE, p.y * SCALE) : road.moveTo(p.x * SCALE, p.y * SCALE)); road.strokePath(); }
    road.lineStyle(1, 0xffffff, .25);
    for (let distance = 15; distance < track.distances.at(-1)!; distance += 16) {
      const a = pointAt(track, distance), b = pointAt(track, Math.min(distance + 6, track.distances.at(-1)!));
      road.lineBetween(a.x * SCALE, a.y * SCALE, b.x * SCALE, b.y * SCALE);
    }
    for (let distance = 100; distance < track.finish.distance; distance += 100) {
      const p = pointAt(track, distance), arrow = scene.add.graphics({ x: p.x * SCALE, y: p.y * SCALE });
      arrow.lineStyle(2, 0xffffff, .6); arrow.beginPath(); arrow.moveTo(-7, -7); arrow.lineTo(3, 0); arrow.lineTo(-7, 7); arrow.strokePath(); arrow.rotation = p.angle;
    }
    for (const gate of track.checkpoints.slice(1)) {
      road.lineStyle(1, 0xffffff, .2);
      const nx = -Math.sin(gate.angle) * track.width / 2 * SCALE, ny = Math.cos(gate.angle) * track.width / 2 * SCALE;
      road.lineBetween(gate.x * SCALE - nx, gate.y * SCALE - ny, gate.x * SCALE + nx, gate.y * SCALE + ny);
    }
    for (const [gate, label] of [[track.start, 'START →'], [track.finish, 'CÍL']] as const) {
      const stripe = scene.add.container(gate.x * SCALE, gate.y * SCALE).setRotation(gate.angle);
      const count = 14, width = track.width * SCALE / count;
      for (let i = 0; i < count; i++) for (let col = 0; col < 2; col++) stripe.add(scene.add.rectangle(col * 5 - 2.5, (i + .5) * width - track.width * SCALE / 2, 5, width, (i + col) % 2 ? 0x111111 : 0xffffff));
      scene.add.text(gate.x * SCALE, gate.y * SCALE - track.width / 2 * SCALE - 26, label, { fontFamily: 'sans-serif', fontSize: '15px', color: '#ffffff' });
    }
    for (const car of this.latest.cars) {
      const body = scene.add.rectangle(0, 0, RACE.carLength * SCALE, RACE.carWidth * SCALE, car.color).setStrokeStyle(car.id === this.ownId ? 3 : 1, 0xffffff);
      const windshield = scene.add.rectangle(6, 0, 7, RACE.carWidth * SCALE - 3, 0x111111);
      const nose = scene.add.triangle(12, 0, 0, -3, 4, 0, 0, 3, 0xffffff);
      const container = scene.add.container(car.x * SCALE, car.y * SCALE, [body, windshield, nose]);
      const name = scene.add.text(0, 0, `${car.name}${car.id === this.ownId ? ' (vy)' : ''}`, { fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', backgroundColor: '#111111', padding: { x: 4, y: 2 } }).setOrigin(.5, 1);
      this.visuals.set(car.id, { car: container, name });
    }
  }

  private estimatedElapsed() {
    const frame = this.frames.at(-1);
    return this.latest.elapsedMs + (frame && this.phase === 'playing' && this.latest.running ? performance.now() - frame.receivedAt : 0);
  }

  private readInput(): DriveInput {
    const own = this.latest.cars.find(c => c.id === this.ownId);
    const allowed = this.phase === 'playing' && this.focused && !document.hidden && own?.status === 'racing' && !own.resetPending && this.estimatedElapsed() >= own.lockedUntil;
    const down = (...codes: string[]) => codes.some(code => this.keys.has(code)) ? 1 : 0;
    const input = { throttle: allowed ? down('KeyW', 'ArrowUp') - down('KeyS', 'ArrowDown') : 0,
      steer: allowed ? down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft') : 0,
      reset: !!allowed && this.resetRequested, seq: ++this.seq };
    this.resetRequested = false;
    return input;
  }

  private interpolate(id: string): CarMotion | undefined {
    const target = this.estimatedElapsed() - INTERPOLATION_MS;
    let before = this.frames[0], after = this.frames.at(-1)!;
    for (const frame of this.frames) { if (frame.snapshot.elapsedMs <= target) before = frame; if (frame.snapshot.elapsedMs >= target) { after = frame; break; } }
    const a = before.snapshot.cars.find(c => c.id === id), b = after.snapshot.cars.find(c => c.id === id);
    if (!a || !b) return b ?? a;
    if (a.resetSerial !== b.resetSerial) return b;
    const duration = after.snapshot.elapsedMs - before.snapshot.elapsedMs;
    const t = duration > 0 ? clamp((target - before.snapshot.elapsedMs) / duration, 0, 1) : 1;
    return { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + angleDifference(b.angle, a.angle) * t };
  }

  private update(deltaMs: number) {
    if (!this.scene || this.destroyed) return;
    this.accumulator += Math.min(deltaMs / 1000, .1);
    const own = this.latest.cars.find(c => c.id === this.ownId);
    while (this.accumulator >= 1 / RACE.physicsHz) {
      if (this.phase === 'playing' && own?.status === 'racing') {
        const input = this.readInput();
        this.send(input as unknown as JsonValue);
        this.pending.push(input); this.pending = this.pending.slice(-120);
        if (this.prediction && !input.reset && !own.resetPending && this.estimatedElapsed() >= own.lockedUntil) this.prediction = predictMotion(this.prediction, input, 1 / RACE.physicsHz, own.catchupBoost);
      }
      this.accumulator -= 1 / RACE.physicsHz;
    }
    for (const car of this.latest.cars) {
      const visual = this.visuals.get(car.id);
      if (!visual) continue;
      const visible = car.status === 'racing'; visual.car.setVisible(visible); visual.name.setVisible(visible);
      if (!visible) continue;
      let motion = this.interpolate(car.id) ?? car;
      if (car.id === this.ownId && this.prediction) {
        const prediction = this.prediction;
        if (!this.shown || Math.hypot(this.shown.x - prediction.x, this.shown.y - prediction.y) > 4) this.shown = { ...prediction };
        else {
          const t = 1 - Math.exp(-20 * deltaMs / 1000);
          this.shown.x += (prediction.x - this.shown.x) * t; this.shown.y += (prediction.y - this.shown.y) * t;
          this.shown.angle += angleDifference(prediction.angle, this.shown.angle) * t;
        }
        motion = this.shown;
      }
      visual.car.setPosition(motion.x * SCALE, motion.y * SCALE).setRotation(motion.angle);
      visual.name.setPosition(motion.x * SCALE, motion.y * SCALE - 18);
    }
    const follow = own?.status === 'racing' ? this.shown ?? own : this.latest.cars.find(c => c.status === 'racing') ?? own;
    if (follow) {
      const camera = this.scene.cameras.main;
      const x = (follow.x + Math.cos(follow.angle) * 19) * SCALE - camera.width / 2;
      const y = (follow.y + Math.sin(follow.angle) * 19) * SCALE - camera.height / 2;
      const t = this.cameraReady ? 1 - Math.exp(-6 * deltaMs / 1000) : 1;
      camera.scrollX += (x - camera.scrollX) * t; camera.scrollY += (y - camera.scrollY) * t; this.cameraReady = true;
    }
    element('race-time').textContent = `${Math.floor(this.estimatedElapsed() / 60000)}:${(Math.floor(this.estimatedElapsed() / 1000) % 60).toString().padStart(2, '0')}`;
  }

  private renderHud() {
    const own = this.latest.cars.find(c => c.id === this.ownId);
    const percent = own ? Math.floor(own.progress / this.data.track.length * 100) : 0;
    element('race-progress').textContent = `${percent} % · checkpoint ${own?.nextCheckpoint ?? 0} / ${this.data.track.checkpoints.length}`;
    element('race-catchup').textContent = own?.status === 'racing' && this.phase === 'playing' && own.catchupBoost > 1.005 ? `Dohánění +${Math.round((own.catchupBoost - 1) * 100)} %` : '';
    element('race-status').textContent = own?.status === 'excluded' ? 'Vyloučen/a po odpojení. Nyní pouze sledujete závod.' : own?.status === 'finished' ? `V cíli za ${(own.finishMs! / 1000).toFixed(2)} s. Sledujete ostatní.` : this.phase !== 'playing' ? 'Start po společném odpočtu · ovládání je uzamčené.' : own?.resetPending ? 'Čekáme na volné bezpečné místo pro návrat.' : own && own.lockedUntil > this.latest.elapsedMs ? 'Návrat na trať · ovládání zablokováno na 2 s.' : 'WASD / šipky · R: návrat za checkpoint';
    const ordered = [...this.latest.cars].sort((a, b) => {
      const status = { finished: 0, racing: 1, excluded: 2 };
      return status[a.status] - status[b.status] || (a.status === 'finished' ? a.finishMs! - b.finishMs! : b.nextCheckpoint - a.nextCheckpoint || b.progress - a.progress);
    });
    let place = 1;
    element('race-order').replaceChildren(...ordered.map((car, index) => {
      const previous = ordered[index - 1];
      const tie = previous && previous.status === car.status && (car.status === 'excluded' || (car.status === 'finished' ? previous.finishMs === car.finishMs : previous.nextCheckpoint === car.nextCheckpoint && Math.abs(previous.progress - car.progress) < .001));
      if (!tie) place = index + 1;
      const item = document.createElement('li');
      item.classList.toggle('is-self', car.id === this.ownId);
      item.textContent = `${place}. ${car.name}${car.id === this.ownId ? ' (vy)' : ''} · ${car.status === 'excluded' ? 'vyloučen/a' : car.status === 'finished' ? `${(car.finishMs! / 1000).toFixed(2)} s` : `${Math.floor(car.progress / this.data.track.length * 100)} %`}`;
      return item;
    }));
  }

  destroy() {
    if (this.destroyed) return;
    this.neutral(); this.destroyed = true;
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur); window.removeEventListener('focus', this.focus);
    document.removeEventListener('visibilitychange', this.visibility);
    this.pending = []; this.frames = []; this.visuals.clear();
    this.game.destroy(true);
    this.scene = undefined;
  }
}
