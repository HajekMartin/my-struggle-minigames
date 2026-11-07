import Phaser from 'phaser';
import { WORMS as W, type WormData, type WormSnapshot, type WormTerrain } from '../shared/worms.js';
import type { JsonValue, MatchPhase } from '../shared/types.js';

const element = (id: string) => document.getElementById(id)!;

export class WormView {
  private game: Phaser.Game;
  private scene?: Phaser.Scene;
  private ground?: Phaser.GameObjects.Graphics;
  private objects?: Phaser.GameObjects.Graphics;
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private terrain: WormTerrain;
  private latest: WormSnapshot;
  private phase: MatchPhase;
  private keys = new Set<string>();
  private jump = false;
  private aim: number;
  private charging = false;
  private controlMs = 0;
  private receivedAt = performance.now();
  private destroyed = false;
  private pointer = { x: 0, y: 0, valid: false };

  constructor(data: WormData, phase: MatchPhase, private ownId: string, private send: (data: JsonValue) => void) {
    this.terrain = data.terrain; this.latest = data.snapshot; this.phase = phase; this.aim = data.snapshot.aim;
    const owner = this;
    class BattleScene extends Phaser.Scene {
      constructor() { super('worms'); }
      create() { owner.create(this); }
      update(_time: number, delta: number) { owner.update(delta); }
    }
    this.game = new Phaser.Game({ type: Phaser.CANVAS, parent: element('worms-canvas'),
      width: window.innerWidth, height: window.innerHeight, backgroundColor: '#111111',
      banner: false, autoFocus: false, scale: { mode: Phaser.Scale.RESIZE }, scene: BattleScene,
      input: { keyboard: false, mouse: false, touch: false, gamepad: false }, render: { antialias: true } });
    window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.neutral); document.addEventListener('visibilitychange', this.visibility);
    element('worms-canvas').addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointermove', this.pointerMove); window.addEventListener('pointerup', this.pointerUp);
    element('worms-end').addEventListener('click', this.end);
    element('worms-leave').addEventListener('click', this.leave);
    this.ingest(data, phase);
  }

  private canControl() { return this.phase === 'playing' && this.latest.phase === 'turn' && this.latest.activeId === this.ownId && !this.latest.shotUsed; }
  private relevant(event: KeyboardEvent) { return ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement); }
  private keyDown = (event: KeyboardEvent) => {
    if (!this.relevant(event)) return;
    event.preventDefault(); this.keys.add(event.code);
    if (event.code === 'Space' && !event.repeat) this.jump = true;
  };
  private keyUp = (event: KeyboardEvent) => { if (this.relevant(event)) { event.preventDefault(); this.keys.delete(event.code); } };
  private pointerMove = (event: PointerEvent) => { this.pointer = { x: event.clientX, y: event.clientY, valid: true }; };
  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.canControl()) return;
    event.preventDefault(); this.pointerMove(event); this.updateAim(); this.sendControl();
    this.charging = true; this.send({ type: 'charge' });
  };
  private pointerUp = (event: PointerEvent) => {
    if (event.button !== 0 || !this.charging) return;
    this.charging = false;
    if (this.canControl()) { this.pointerMove(event); this.updateAim(); this.sendControl(); this.send({ type: 'fire' }); }
  };
  private neutral = () => { this.keys.clear(); this.jump = false; this.charging = false; if (this.canControl()) this.send({ type: 'neutral' }); };
  private visibility = () => { if (document.hidden) this.neutral(); };
  private end = () => { if (this.canControl()) { this.charging = false; this.send({ type: 'end' }); } };
  private leave = () => element('leave').click();

  ingest(data: WormData, phase: MatchPhase) {
    if (this.destroyed) return;
    if (data.snapshot.turnNumber !== this.latest.turnNumber || data.snapshot.phase !== this.latest.phase) {
      this.keys.clear(); this.jump = false; this.charging = false; this.aim = data.snapshot.aim;
    }
    this.latest = data.snapshot; this.phase = phase; this.receivedAt = performance.now();
    if (data.terrain.revision !== this.terrain.revision) { this.terrain = data.terrain; this.drawTerrain(); }
    this.renderHud();
  }

  private create(scene: Phaser.Scene) {
    this.scene = scene;
    this.ground = scene.add.graphics(); this.objects = scene.add.graphics();
    this.drawTerrain();
    for (const c of this.latest.characters) this.labels.set(c.id, scene.add.text(c.x, c.y - 26, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '14px', color: '#ffffff', backgroundColor: '#111111', padding: { x: 4, y: 3 }, align: 'center'
    }).setOrigin(.5, 1));
    this.resize(); scene.scale.on('resize', this.resize);
  }

  private resize = () => {
    if (!this.scene) return;
    const width = this.scene.scale.width, height = this.scene.scale.height;
    const top = Math.min(140, height * .22), available = Math.max(100, height - top - 90);
    this.scene.cameras.main.setViewport(0, top, width, available)
      .setZoom(Math.min((width - 24) / W.width, available / W.height)).centerOn(W.width / 2, W.height / 2);
  };

  private drawTerrain() {
    if (!this.ground) return;
    const g = this.ground.clear();
    g.fillStyle(0x383838);
    this.terrain.columns.forEach((column, index) => {
      for (let i = 0; i < column.length; i += 2) g.fillRect(index * W.terrainStep, column[i], W.terrainStep, column[i + 1] - column[i]);
    });
    // Bright surfaces remain legible against the dark sky and make crater edges clear.
    g.lineStyle(2, 0xbdbdbd);
    this.terrain.columns.forEach((column, index) => {
      for (let i = 0; i < column.length; i += 2) g.lineBetween(index * W.terrainStep, column[i], (index + 1) * W.terrainStep, column[i]);
    });
    g.fillStyle(0x183448); g.fillRect(0, W.waterY, W.width, W.height - W.waterY);
    g.lineStyle(2, 0x8bb7ca); g.lineBetween(0, W.waterY, W.width, W.waterY);
  }

  private updateAim() {
    const own = this.latest.characters.find(c => c.id === this.ownId);
    if (!own || !this.scene || !this.pointer.valid || !this.canControl()) return;
    const rect = this.game.canvas.getBoundingClientRect();
    const point = this.scene.cameras.main.getWorldPoint(this.pointer.x - rect.left, this.pointer.y - rect.top);
    this.aim = Math.atan2(point.y - own.y, point.x - own.x);
  }
  private sendControl() {
    if (!this.canControl()) { this.jump = false; return; }
    const move = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    this.send({ type: 'control', move, jump: this.jump, aim: this.aim }); this.jump = false;
  }
  private update(delta: number) {
    if (!this.objects || this.destroyed) return;
    this.updateAim(); this.controlMs += delta;
    if (this.controlMs >= 50) { this.controlMs %= 50; this.sendControl(); }
    const g = this.objects.clear();
    for (const c of this.latest.characters) {
      const label = this.labels.get(c.id)!; label.setVisible(c.status === 'alive');
      if (c.status !== 'alive') continue;
      const active = c.id === this.latest.activeId;
      if (active) { g.lineStyle(3, 0xffffff); g.strokeCircle(c.x, c.y, W.radius + 5); }
      g.fillStyle(c.color); g.fillCircle(c.x, c.y, W.radius);
      g.fillStyle(0x111111); g.fillCircle(c.x - 3, c.y - 2, 2); g.fillCircle(c.x + 3, c.y - 2, 2);
      label.setPosition(c.x, c.y - 24).setText(`${c.name}${c.id === this.ownId ? ' (vy)' : ''} · ${c.hp} ♥`);
      if (active && this.latest.phase === 'turn') {
        const angle = c.id === this.ownId ? this.aim : this.latest.aim;
        g.lineStyle(3, 0xffffff); g.lineBetween(c.x, c.y, c.x + Math.cos(angle) * 45, c.y + Math.sin(angle) * 45);
      }
    }
    const p = this.latest.projectile;
    if (p) { g.fillStyle(0xffffff); g.fillCircle(p.x, p.y, W.projectileRadius + 1); }
    const e = this.latest.explosion;
    if (e && !p && this.latest.phase === 'effects') {
      // A static outline marks the most recent impact; terrain already contains its crater.
      g.lineStyle(2, 0xb71c1c, .8); g.strokeCircle(e.x, e.y, W.blastRadius);
    }
    this.renderHud();
  }

  private renderHud() {
    const s = this.latest, active = s.characters.find(c => c.id === s.activeId);
    const now = s.elapsedMs + (s.running && !s.over ? performance.now() - this.receivedAt : 0);
    element('worms-active').textContent = this.phase !== 'playing' ? 'Bazukový souboj' : s.phase === 'effects' ? 'Dopad a ustálení postav' : active ? `Na tahu: ${active.name}${active.id === this.ownId ? ' (vy)' : ''}` : 'Souboj dokončen';
    element('worms-time').textContent = s.phase === 'turn' ? `${Math.max(0, Math.ceil((Math.min(s.turnEndsAt, W.matchMs) - now) / 1000))} s` : '';
    element('worms-stamina').textContent = `Stamina: ${Math.ceil(active?.stamina ?? 0)} / ${W.stamina}`;
    const power = s.chargeStartedAt === null ? 0 : Math.round(Math.min(1, (now - s.chargeStartedAt) / W.chargeMs) * 100);
    const meter = element('worms-power') as HTMLProgressElement; meter.value = power;
    element('worms-power-label').textContent = `Síla: ${power} %`;
    (element('worms-end') as HTMLButtonElement).disabled = !this.canControl();
    element('worms-help').textContent = this.phase === 'rules' ? 'A/D nebo šipky · mezerník: skok · myš: míření, podržet a pustit: výstřel. Voda vyřazuje.'
      : this.phase === 'countdown' ? 'Společný start po odpočtu.' : this.latest.characters.find(c => c.id === this.ownId)?.status !== 'alive' ? 'Jste vyřazeni. Sledujete souboj.'
      : this.canControl() ? 'A/D: pohyb · mezerník: skok · levé tlačítko myši: nabít a vystřelit' : 'Sledujete tah soupeře a jeho účinky.';
    // Only rebuild the small text roster when its displayed values change.
    const roster = s.order.map(id => s.characters.find(c => c.id === id)!).map(c => `${c.id === s.activeId ? '▶ ' : ''}${c.name}: ${c.status === 'alive' ? `${c.hp} ♥` : c.status === 'dead' ? 'Vyřazen/a' : 'Odpojen/a'}`).join(' · ');
    if (element('worms-players').textContent !== roster) element('worms-players').textContent = roster;
  }

  destroy() {
    if (this.destroyed) return;
    this.neutral(); this.destroyed = true;
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.neutral); document.removeEventListener('visibilitychange', this.visibility);
    element('worms-canvas').removeEventListener('pointerdown', this.pointerDown);
    window.removeEventListener('pointermove', this.pointerMove); window.removeEventListener('pointerup', this.pointerUp);
    element('worms-end').removeEventListener('click', this.end); element('worms-leave').removeEventListener('click', this.leave);
    this.scene?.scale.off('resize', this.resize); this.game.destroy(true); this.labels.clear();
  }
}
