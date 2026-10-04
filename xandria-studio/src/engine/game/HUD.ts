/**
 * DOM HUD overlay: health/boost bars, objective tracker, score, timer, crosshair,
 * damage vignette, pause + end screens. Zero three.js cost; crisp at any resolution.
 */
import type { GameSpec, NarrativeSpec } from '@spec';
import type { Engine } from '../Engine';
import type { UpgradeDef } from './Progression';

/** End-of-run stats shown on the victory/defeat screen. */
export interface RunStats {
  score: number;
  /** run length in seconds */
  time: number;
  kills: number;
  level: number;
  stagesCleared: number;
  /** defeat reason (ignored on victory) */
  reason?: string;
}

const CSS = `
.xhud { position:absolute; inset:0; pointer-events:none; font-family:'Segoe UI',system-ui,sans-serif; color:#e8ecf1; user-select:none; z-index:10; }
.xhud .panel { position:absolute; padding:10px 14px; background:rgba(10,14,20,.55); border:1px solid rgba(140,180,220,.25); border-radius:10px; backdrop-filter:blur(4px); }
.xhud .bars { left:16px; bottom:16px; width:240px; }
.xhud .bar { height:14px; border-radius:7px; background:rgba(255,255,255,.12); overflow:hidden; margin-top:6px; }
.xhud .bar > div { height:100%; border-radius:7px; transition:width .15s ease; }
.xhud .hp > div { background:linear-gradient(90deg,#ff4d5e,#ff8a5c); }
.xhud .boost > div { background:linear-gradient(90deg,#3fa9f5,#7af7ff); }
.xhud .barlabel { font-size:11px; letter-spacing:.12em; opacity:.75; margin-top:8px; }
.xhud .objective { top:16px; left:16px; max-width:320px; }
.xhud .objective .title { font-size:13px; font-weight:600; letter-spacing:.06em; }
.xhud .objective .desc { font-size:12px; opacity:.8; margin-top:3px; }
.xhud .objective .progress { font-size:15px; font-weight:700; color:#ffd23f; margin-top:4px; }
.xhud .score { top:16px; right:16px; text-align:right; }
.xhud .score .val { font-size:22px; font-weight:800; color:#ffd23f; }
.xhud .score .lbl { font-size:10px; letter-spacing:.18em; opacity:.7; }
.xhud .timer { font-size:13px; opacity:.9; margin-top:4px; font-variant-numeric:tabular-nums; }
.xhud .lives { font-size:13px; margin-top:2px; color:#ff8a9a; }
.xhud .crosshair { position:absolute; left:50%; top:50%; width:14px; height:14px; transform:translate(-50%,-50%); }
.xhud .crosshair::before, .xhud .crosshair::after { content:''; position:absolute; background:rgba(240,250,255,.9); }
.xhud .crosshair::before { left:6px; top:0; width:2px; height:14px; }
.xhud .crosshair::after { left:0; top:6px; width:14px; height:2px; }
.xhud .vignette { position:absolute; inset:0; background:radial-gradient(ellipse at center, transparent 55%, rgba(255,30,40,.55) 100%); opacity:0; transition:opacity .1s; }
.xhud .toast { position:absolute; left:50%; top:18%; transform:translateX(-50%); font-size:20px; font-weight:700; letter-spacing:.1em; text-shadow:0 2px 12px rgba(0,0,0,.7); opacity:0; transition:opacity .3s; }
.xhud .hint { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); font-size:11.5px; opacity:.65; background:rgba(10,14,20,.5); padding:6px 12px; border-radius:8px; }
.xhud .overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(6,8,14,.72); backdrop-filter:blur(6px); pointer-events:auto; }
.xhud .overlay h1 { font-size:44px; letter-spacing:.14em; margin:0 0 8px; }
.xhud .overlay .sub { font-size:15px; opacity:.85; margin-bottom:6px; }
.xhud .overlay .stats { font-size:13px; opacity:.7; margin-bottom:26px; font-variant-numeric:tabular-nums; }
.xhud .overlay button { pointer-events:auto; cursor:pointer; font-size:15px; font-weight:600; letter-spacing:.08em; padding:12px 34px; border-radius:10px; border:1px solid rgba(140,180,220,.4); background:linear-gradient(180deg,#2b3f57,#1a2536); color:#e8ecf1; margin:4px; }
.xhud .overlay button:hover { background:linear-gradient(180deg,#3a5474,#223048); }
.xhud .boss { position:absolute; left:50%; top:56px; transform:translateX(-50%); width:340px; text-align:center; }
.xhud .boss .bar { height:10px; }
.xhud .boss .name { font-size:12px; letter-spacing:.2em; opacity:.85; margin-bottom:4px; }
.xhud .card { position:absolute; left:50%; top:13%; transform:translateX(-50%); max-width:440px; width:calc(100% - 48px); padding:18px 24px 20px; background:rgba(10,14,20,.9); border:1px solid rgba(255,210,63,.4); border-radius:12px; backdrop-filter:blur(6px); pointer-events:auto; text-align:center; animation:cardin .25s ease; cursor:pointer; }
.xhud .card h2 { font-size:19px; letter-spacing:.14em; margin:0 0 8px; color:#ffd23f; }
.xhud .card p { font-size:13.5px; opacity:.92; line-height:1.6; margin:0 0 14px; }
.xhud .card .btn { display:inline-block; font-size:13px; font-weight:700; letter-spacing:.1em; padding:9px 26px; border-radius:8px; border:1px solid rgba(140,180,220,.4); background:linear-gradient(180deg,#2b3f57,#1a2536); color:#e8ecf1; cursor:pointer; }
.xhud .lvlopts { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; justify-content:center; }
.xhud .lvlopt { flex:1 1 150px; max-width:210px; padding:14px 12px; border-radius:10px; border:1px solid rgba(140,180,220,.35); background:linear-gradient(180deg,#223048,#141c2c); color:#e8ecf1; cursor:pointer; text-align:center; }
.xhud .lvlopt:hover { border-color:#ffd23f; background:linear-gradient(180deg,#2e4258,#1a2438); }
.xhud .lvlopt .nm { font-size:14px; font-weight:700; letter-spacing:.06em; color:#ffd23f; margin-bottom:6px; }
.xhud .lvlopt .ds { font-size:12px; opacity:.8; line-height:1.45; }
.xhud .title-screen { background:rgba(4,6,10,.62); }
.xhud .title-screen .tag { font-size:13px; letter-spacing:.5em; opacity:.6; margin-bottom:10px; }
.xhud .title-screen h1 { font-size:52px; }
.xhud .title-screen .premise { max-width:520px; font-size:15px; line-height:1.65; opacity:.92; margin:0 24px 18px; text-align:center; }
.xhud .title-screen .controls { display:flex; flex-wrap:wrap; gap:6px 18px; justify-content:center; max-width:520px; font-size:12px; opacity:.65; margin-bottom:26px; }
.xhud .title-screen .start-btn { font-size:18px; padding:14px 44px; animation:pulse 1.6s ease-in-out infinite; }
.xhud .title-screen .profile-line { font-size:12px; letter-spacing:.08em; opacity:.7; margin:-8px 0 14px; }
.xhud .title-screen .merit-line { font-size:13px; letter-spacing:.08em; color:#ffd23f; margin-bottom:10px; }
.xhud .title-screen .mods { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; max-width:560px; margin-bottom:14px; }
.xhud .title-screen .mod { pointer-events:auto; border:1px solid rgba(140,180,220,.35); border-radius:8px; padding:8px 10px; font-size:11px; text-align:center; min-width:110px; max-width:130px; background:rgba(20,28,44,.7); cursor:pointer; }
.xhud .title-screen .mod .mn { font-weight:700; letter-spacing:.05em; margin-bottom:3px; }
.xhud .title-screen .mod .md { opacity:.75; line-height:1.4; margin-bottom:5px; }
.xhud .title-screen .mod .ma { font-size:10px; letter-spacing:.08em; color:#ffd23f; }
.xhud .title-screen .mod.equipped { border-color:#ffd23f; background:rgba(60,48,16,.6); }
.xhud .title-screen .mod.locked { opacity:.55; cursor:pointer; }
.xhud .title-screen .daily-row { display:flex; gap:12px; align-items:center; justify-content:center; margin-bottom:18px; }
.xhud .title-screen .daily-btn { font-size:14px; padding:10px 26px; }
.xhud .title-screen .daily-best { font-size:12px; opacity:.7; }
@keyframes pulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.05); } }
.xhud .settings { display:flex; flex-direction:column; gap:14px; margin-bottom:24px; min-width:300px; }
.xhud .settings-row { display:flex; align-items:center; gap:14px; font-size:13px; letter-spacing:.1em; }
.xhud .settings-row span { width:110px; text-align:right; opacity:.8; }
.xhud .settings-row input[type=range] { flex:1; accent-color:#ffd23f; }
.xhud .settings-row select { flex:1; background:#1a2536; color:#e8ecf1; border:1px solid rgba(140,180,220,.4); border-radius:8px; padding:8px 10px; font-size:13px; }
.xhud .settings-row input[type=checkbox] { width:20px; height:20px; accent-color:#ffd23f; }
@keyframes cardin { from { opacity:0; transform:translate(-50%,-10px); } }
/* touch mode: keep HUD clear of the joystick (bottom-left) and buttons (bottom-right) */
.xhud.touch .bars { left:12px; bottom:200px; width:190px; }
.xhud.touch .hint { bottom:210px; }
.xhud.touch .objective { top:max(12px, env(safe-area-inset-top)); left:max(12px, env(safe-area-inset-left)); }
.xhud.touch .score { top:max(12px, env(safe-area-inset-top)); right:max(12px, env(safe-area-inset-right)); }
/* small screens: compact panels */
@media (max-width:760px) {
  .xhud .bars { width:180px; padding:8px 10px; }
  .xhud .objective { max-width:230px; padding:8px 10px; }
  .xhud .objective .title { font-size:12px; }
  .xhud .score .val { font-size:17px; }
  .xhud .boss { width:min(300px, 70vw); top:48px; }
  .xhud .overlay h1 { font-size:32px; }
  .xhud .toast { font-size:16px; top:14%; }
  .xhud .card { top:10%; }
}
`;

export class HUD {
  private root: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private boostFill: HTMLDivElement;
  private objTitle: HTMLDivElement;
  private objDesc: HTMLDivElement;
  private objProg: HTMLDivElement;
  private scoreVal: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private livesEl: HTMLDivElement;
  private vignette: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private overlay: HTMLDivElement | null = null;
  private boostBar: HTMLDivElement;
  private vignetteT = 0;
  private toastT = 0;
  private lowHp = false;
  private hintEl: HTMLDivElement;
  private bossEl: HTMLDivElement;
  private bossName: HTMLDivElement;
  private bossFill: HTMLDivElement;

  constructor(private container: HTMLElement, private spec: GameSpec) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'xhud';
    this.root.innerHTML = `
      <div class="panel bars">
        <div class="barlabel">INTEGRITY</div>
        <div class="bar hp"><div style="width:100%"></div></div>
        <div class="barlabel boostlabel">BOOST</div>
        <div class="bar boost"><div style="width:100%"></div></div>
      </div>
      <div class="panel objective">
        <div class="title"></div>
        <div class="desc"></div>
        <div class="progress"></div>
      </div>
      <div class="panel score">
        <div class="val">0</div>
        <div class="lbl">SCORE</div>
        <div class="timer"></div>
        <div class="lives"></div>
      </div>
      <div class="vignette"></div>
      <div class="toast"></div>
      <div class="hint"></div>
      <div class="boss" style="display:none"><div class="name"></div><div class="bar"><div style="width:100%"></div></div></div>`;
    container.style.position = 'relative';
    container.appendChild(this.root);

    this.hpFill = this.root.querySelector('.hp > div')!;
    this.boostBar = this.root.querySelector('.boost')!;
    this.boostFill = this.root.querySelector('.boost > div')!;
    this.objTitle = this.root.querySelector('.objective .title')!;
    this.objDesc = this.root.querySelector('.objective .desc')!;
    this.objProg = this.root.querySelector('.objective .progress')!;
    this.scoreVal = this.root.querySelector('.score .val')!;
    this.timerEl = this.root.querySelector('.timer')!;
    this.livesEl = this.root.querySelector('.lives')!;
    this.vignette = this.root.querySelector('.vignette')!;
    this.toastEl = this.root.querySelector('.toast')!;
    this.hintEl = this.root.querySelector('.hint')!;
    this.bossEl = this.root.querySelector('.boss')!;
    this.bossName = this.root.querySelector('.boss .name')!;
    this.bossFill = this.root.querySelector('.boss .bar > div')!;
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'crosshair';
    this.crosshair.style.display = 'none';
    this.root.appendChild(this.crosshair);

    this.setObjective(spec.objective.description, '');
    this.hintEl.textContent = '';
  }

  setObjective(title: string, desc: string) {
    this.objTitle.textContent = title;
    this.objDesc.textContent = desc;
  }
  setProgress(text: string) { this.objProg.textContent = text; }
  setScore(v: number) { this.scoreVal.textContent = String(Math.round(v)); }
  setHealth(frac: number) { this.hpFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`; }
  setBoost(frac: number) { this.boostFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`; }
  showBoostBar(show: boolean) {
    this.boostBar.style.display = show ? '' : 'none';
    (this.root.querySelector('.boostlabel') as HTMLElement).style.display = show ? '' : 'none';
  }
  setTimer(seconds: number) {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    this.timerEl.textContent = `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  setLives(n: number) { this.livesEl.textContent = n > 1 ? '♥'.repeat(Math.min(9, n)) : ''; }
  setCrosshair(show: boolean) { this.crosshair.style.display = show ? '' : 'none'; }
  setHint(text: string) { this.hintEl.textContent = text; }
  /** Boss health bar. Pass null to hide. */
  setBoss(name: string | null, frac: number) {
    if (name === null) { this.bossEl.style.display = 'none'; return; }
    this.bossEl.style.display = '';
    this.bossName.textContent = name;
    this.bossFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  /** Engine reference for modal flows (level-up pause). Set by Engine. */
  private eng: Engine | null = null;
  attachEngine(e: Engine) {
    this.eng = e;
  }

  /**
   * Touch mode: shifts HUD panels clear of the touch overlay (joystick bottom-left,
   * buttons bottom-right) and applies small-screen compaction.
   */
  setTouchMode(on: boolean) {
    this.root.classList.toggle('touch', on);
  }

  private get narrative(): NarrativeSpec | undefined {
    return this.spec.narrative;
  }

  /**
   * Story card — centered overlay, NON-blocking (the game keeps running).
   * Auto-dismisses after 3.5s or on click. Awaiting it is optional.
   */
  showCard(title: string, body: string, buttonText = 'CONTINUE'): Promise<void> {
    // dismiss any previous card first
    this.root.querySelector('.card')?.remove();
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'card';
      const h = document.createElement('h2');
      h.textContent = title;
      const p = document.createElement('p');
      p.textContent = body;
      const b = document.createElement('span');
      b.className = 'btn';
      b.textContent = buttonText;
      el.append(h, p, b);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.remove();
        resolve();
      };
      el.addEventListener('click', finish);
      this.root.appendChild(el);
      const timer = setTimeout(finish, 3500);
    });
  }

  /**
   * Level-up modal — PAUSES the game until the player picks one of the
   * 3 upgrade choices. Resolves with the chosen upgrade id.
   */
  showLevelUp(choices: UpgradeDef[]): Promise<string> {
    const eng = this.eng;
    const wasPlaying = eng?.state === 'playing';
    if (wasPlaying) eng!.pause();
    return new Promise<string>((resolve) => {
      const el = document.createElement('div');
      el.className = 'overlay';
      const h = document.createElement('h1');
      h.textContent = 'LEVEL UP';
      h.style.color = '#ffd23f';
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = 'Choose an upgrade';
      const opts = document.createElement('div');
      opts.className = 'lvlopts';
      for (const c of choices) {
        const b = document.createElement('button');
        b.className = 'lvlopt';
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = c.name;
        const ds = document.createElement('div');
        ds.className = 'ds';
        ds.textContent = c.desc;
        b.append(nm, ds);
        b.addEventListener('click', () => {
          el.remove();
          if (wasPlaying) eng!.resume();
          resolve(c.id);
        });
        opts.appendChild(b);
      }
      el.append(h, sub, opts);
      this.root.appendChild(el);
    });
  }

  /**
   * Branch-choice modal — PAUSES the game until the player picks one of the
   * options. Click a button or press 1-9. Resolves with the chosen option index.
   */
  showChoice(title: string, body: string, options: string[]): Promise<number> {
    const eng = this.eng;
    const wasPlaying = eng?.state === 'playing';
    if (wasPlaying) eng!.pause();
    return new Promise<number>((resolve) => {
      let done = false;
      const el = document.createElement('div');
      el.className = 'overlay';
      const h = document.createElement('h1');
      h.textContent = title;
      h.style.color = '#ffd23f';
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = body;
      const hint = document.createElement('div');
      hint.className = 'sub';
      hint.textContent = options.length > 1 ? 'Click, or press 1–' + Math.min(9, options.length) : '';
      const opts = document.createElement('div');
      opts.className = 'lvlopts';
      const pick = (i: number) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        el.remove();
        if (wasPlaying) eng!.resume();
        resolve(i);
      };
      const onKey = (e: KeyboardEvent) => {
        const n = parseInt(e.key, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, options.length)) pick(n - 1);
      };
      options.forEach((label, i) => {
        const b = document.createElement('button');
        b.className = 'lvlopt';
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = (i < 9 ? `${i + 1}. ` : '') + label;
        b.append(nm);
        b.addEventListener('click', () => pick(i));
        opts.appendChild(b);
      });
      el.append(h, sub, hint, opts);
      this.root.appendChild(el);
      document.addEventListener('keydown', onKey);
    });
  }

  damageFlash() {
    this.vignetteT = 0.35;
    // every blueprint routes player damage through here — free screenshake
    this.eng?.juice.shake(0.35);
  }

  /** Low-HP heartbeat vignette pulse (blueprints toggle based on health frac). */
  setLowHp(on: boolean) { this.lowHp = on; }

  toast(text: string, seconds = 2.2) {
    this.toastEl.textContent = text;
    this.toastT = seconds;
  }

  update(dt: number) {
    this.vignetteT = Math.max(0, this.vignetteT - dt);
    const dmg = Math.min(1, this.vignetteT * 3);
    const pulse = this.lowHp ? 0.22 + 0.13 * Math.sin(performance.now() / 170) : 0;
    this.vignette.style.opacity = String(Math.max(dmg, pulse));
    this.toastT = Math.max(0, this.toastT - dt);
    this.toastEl.style.opacity = String(Math.min(1, this.toastT * 1.5));
  }

  /**
   * Title screen — game name, narrative premise, controls, click-to-start.
   * onStart fires once; the engine removes the overlay and starts the run.
   *
   * Cross-run progression (all optional): profileLine summarizes the player's
   * history, merit/modifiers render the loadout UI (buy/equip via the
   * callbacks, which re-render the title), and the daily row offers the
   * daily-challenge run with its local best.
   */
  showTitle(opts: {
    name: string;
    premise: string;
    controls: string[];
    onStart: () => void;
    profileLine?: string;
    merit?: number;
    modifiers?: Array<{
      id: string; name: string; desc: string; cost: number;
      owned: boolean; equipped: boolean;
    }>;
    onToggleModifier?: (id: string) => void;
    onBuyModifier?: (id: string) => void;
    dailyLabel?: string;
    dailyBest?: number | null;
    onDaily?: () => void;
  }) {
    this.clearOverlays();
    const ov = document.createElement('div');
    ov.className = 'overlay title-screen';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = 'XANDRIA';
    const h = document.createElement('h1');
    h.textContent = opts.name;
    const p = document.createElement('p');
    p.className = 'premise';
    p.textContent = opts.premise;
    ov.append(tag, h, p);

    if (opts.profileLine) {
      const pl = document.createElement('div');
      pl.className = 'profile-line';
      pl.textContent = opts.profileLine;
      ov.appendChild(pl);
    }

    if (opts.modifiers && opts.modifiers.length) {
      const ml = document.createElement('div');
      ml.className = 'merit-line';
      ml.textContent = `◆ ${opts.merit ?? 0} merit`;
      ov.appendChild(ml);
      const mods = document.createElement('div');
      mods.className = 'mods';
      for (const m of opts.modifiers) {
        const d = document.createElement('div');
        d.className = 'mod' + (m.equipped ? ' equipped' : m.owned ? '' : ' locked');
        const nm = document.createElement('div');
        nm.className = 'mn';
        nm.textContent = m.name;
        const ds = document.createElement('div');
        ds.className = 'md';
        ds.textContent = m.desc;
        const ac = document.createElement('div');
        ac.className = 'ma';
        ac.textContent = m.equipped ? 'EQUIPPED' : m.owned ? 'EQUIP' : `BUY ◆${m.cost}`;
        d.append(nm, ds, ac);
        d.addEventListener('click', (e) => {
          e.stopPropagation();
          if (m.equipped || m.owned) opts.onToggleModifier?.(m.id);
          else opts.onBuyModifier?.(m.id);
        });
        mods.appendChild(d);
      }
      ov.appendChild(mods);
    }

    const cl = document.createElement('div');
    cl.className = 'controls';
    for (const c of opts.controls) {
      const d = document.createElement('div');
      d.textContent = c;
      cl.appendChild(d);
    }
    ov.appendChild(cl);

    const b = document.createElement('button');
    b.className = 'start-btn';
    b.textContent = 'CLICK TO START';
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      opts.onStart();
    };
    b.addEventListener('click', (e) => { e.stopPropagation(); go(); });

    if (opts.onDaily && opts.dailyLabel) {
      const row = document.createElement('div');
      row.className = 'daily-row';
      const db = document.createElement('button');
      db.className = 'daily-btn';
      db.textContent = opts.dailyLabel;
      db.addEventListener('click', (e) => {
        e.stopPropagation();
        if (started) return;
        started = true;
        opts.onDaily!();
      });
      row.appendChild(db);
      if (opts.dailyBest != null && opts.dailyBest > 0) {
        const best = document.createElement('div');
        best.className = 'daily-best';
        best.textContent = `today's best: ${opts.dailyBest.toLocaleString()}`;
        row.appendChild(best);
      }
      ov.append(b, row);
    } else {
      ov.appendChild(b);
    }

    ov.addEventListener('click', go);
    this.root.appendChild(ov);
    this.overlay = ov;
  }

  showPause() {
    this.clearOverlays();
    const eng = this.eng;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    const h = document.createElement('h1');
    h.textContent = 'PAUSED';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = this.spec.meta.name;
    const btns = document.createElement('div');
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { eng?.audio.play('click'); fn(); });
      return b;
    };
    btns.append(
      mk('RESUME', () => eng?.togglePause()),
      mk('RESTART', () => eng?.restart()),
      mk('SETTINGS', () => this.showSettings(ov)),
      mk('QUIT TO TITLE', () => eng?.toTitle()),
    );
    ov.append(h, sub, btns);
    this.root.appendChild(ov);
    this.overlay = ov;
  }
  hidePause() { this.clearOverlays(); }

  /** Settings panel rendered inside the pause overlay. */
  private showSettings(ov: HTMLDivElement) {
    const eng = this.eng;
    ov.innerHTML = '';
    const h = document.createElement('h1');
    h.textContent = 'SETTINGS';
    h.style.fontSize = '30px';
    const s = eng?.settings.data ?? { volume: 0.8, muted: false, quality: 'auto' as const };
    const wrap = document.createElement('div');
    wrap.className = 'settings';

    const vrow = document.createElement('div');
    vrow.className = 'settings-row';
    const vlab = document.createElement('span');
    vlab.textContent = 'VOLUME';
    const vsl = document.createElement('input');
    vsl.type = 'range'; vsl.min = '0'; vsl.max = '100';
    vsl.value = String(Math.round(s.volume * 100));
    vsl.setAttribute('aria-label', 'Volume');
    vsl.addEventListener('input', () => {
      eng?.settings.set({ volume: Number(vsl.value) / 100 });
      eng?.applySettings();
    });
    vrow.append(vlab, vsl);

    const qrow = document.createElement('div');
    qrow.className = 'settings-row';
    const qlab = document.createElement('span');
    qlab.textContent = 'QUALITY';
    const qsel = document.createElement('select');
    qsel.setAttribute('aria-label', 'Quality');
    for (const q of ['auto', 'retro', 'standard', 'high'] as const) {
      const o = document.createElement('option');
      o.value = q;
      o.textContent = q.toUpperCase();
      if (q === s.quality) o.selected = true;
      qsel.appendChild(o);
    }
    qsel.addEventListener('change', () => {
      eng?.settings.set({ quality: qsel.value as typeof s.quality });
      eng?.applySettings();
    });
    qrow.append(qlab, qsel);

    const mrow = document.createElement('div');
    mrow.className = 'settings-row';
    const mlab = document.createElement('span');
    mlab.textContent = 'MUTE';
    const mcb = document.createElement('input');
    mcb.type = 'checkbox';
    mcb.checked = s.muted;
    mcb.setAttribute('aria-label', 'Mute');
    mcb.addEventListener('change', () => {
      eng?.settings.set({ muted: mcb.checked });
      eng?.applySettings();
    });
    mrow.append(mlab, mcb);

    const back = document.createElement('button');
    back.textContent = 'BACK';
    back.addEventListener('click', () => { eng?.audio.play('click'); this.showPause(); });
    wrap.append(vrow, qrow, mrow);
    ov.append(h, wrap, back);
    this.overlay = ov;
  }

  showEnd(won: boolean, stats: RunStats, winText?: string) {
    this.clearOverlays();
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    const m = Math.floor(stats.time / 60),
      s = Math.floor(stats.time % 60);
    const nar = this.narrative;
    // textContent (not innerHTML): narrative text comes from spec/LLM input
    // Per-branch winText (quest graph terminal stage) beats the campaign default.
    const subText = won
      ? winText || nar?.winText || this.spec.objective.description
      : stats.reason || nar?.loseText || 'You fell.';
    const stageBit = stats.stagesCleared > 0 ? ` · STAGES ${stats.stagesCleared}` : '';
    const h = document.createElement('h1');
    h.textContent = won ? 'VICTORY' : 'DEFEATED';
    h.style.color = won ? '#7dffa8' : '#ff6a7a';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = subText;
    const statsEl = document.createElement('div');
    statsEl.className = 'stats';
    statsEl.textContent =
      `SCORE ${Math.round(stats.score)} · TIME ${m}:${String(s).padStart(2, '0')}` +
      ` · KILLS ${stats.kills} · LEVEL ${stats.level}${stageBit}`;
    const btnWrap = document.createElement('div');
    const again = document.createElement('button');
    again.textContent = 'RESTART';
    again.addEventListener('click', () => this.eng?.restart());
    const title = document.createElement('button');
    title.textContent = 'TITLE';
    title.addEventListener('click', () => this.eng?.toTitle());
    btnWrap.append(again, title);
    this.overlay.append(h, sub, statsEl, btnWrap);
    this.root.appendChild(this.overlay);
  }

  /** Reset HUD for an in-place restart. */
  resetRun() {
    this.clearOverlays();
    this.setScore(0);
    this.setHealth(1);
    this.setBoost(1);
    this.setBoss(null, 0);
    this.setCrosshair(false);
    this.setObjective(this.spec.objective.description, '');
    this.setProgress('');
    this.setHint('');
    this.setLowHp(false);
    this.vignetteT = 0;
    this.toastT = 0;
    this.vignette.style.opacity = '0';
    this.toastEl.style.opacity = '0';
  }

  /** Remove any overlay (title / pause / settings / end / level-up). Public for Engine. */
  clearOverlays() { this.overlay?.remove(); this.overlay = null; }
}
