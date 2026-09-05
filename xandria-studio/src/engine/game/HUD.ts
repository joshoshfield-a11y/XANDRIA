/**
 * DOM HUD overlay: health/boost bars, objective tracker, score, timer, crosshair,
 * damage vignette, pause + end screens. Zero three.js cost; crisp at any resolution.
 */
import type { GameSpec } from '@spec';

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
  private hintEl: HTMLDivElement;

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
      <div class="hint"></div>`;
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

  damageFlash() { this.vignetteT = 0.35; }
  toast(text: string, seconds = 2.2) {
    this.toastEl.textContent = text;
    this.toastT = seconds;
  }

  update(dt: number) {
    this.vignetteT = Math.max(0, this.vignetteT - dt);
    this.vignette.style.opacity = String(Math.min(1, this.vignetteT * 3));
    this.toastT = Math.max(0, this.toastT - dt);
    this.toastEl.style.opacity = String(Math.min(1, this.toastT * 1.5));
  }

  showPause() {
    this.clearOverlay();
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.overlay.innerHTML = `<h1>PAUSED</h1><div class="sub">${this.spec.meta.name}</div><div><button data-a="resume">RESUME</button><button data-a="restart">RESTART</button></div>`;
    this.root.appendChild(this.overlay);
    this.overlay.querySelector('[data-a="resume"]')?.addEventListener('click', () => (window.__XANDRIA__ as any)?.engine.togglePause());
    this.overlay.querySelector('[data-a="restart"]')?.addEventListener('click', () => (window.__XANDRIA__ as any)?.engine.restart());
  }
  hidePause() { this.clearOverlay(); }

  showEnd(won: boolean, score: number, time: number, reason = '') {
    this.clearOverlay();
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.overlay.innerHTML = `
      <h1 style="color:${won ? '#7dffa8' : '#ff6a7a'}">${won ? 'VICTORY' : 'DEFEATED'}</h1>
      <div class="sub">${won ? this.spec.objective.description : reason || 'You fell.'}</div>
      <div class="stats">SCORE ${Math.round(score)} · TIME ${m}:${String(s).padStart(2, '0')}</div>
      <div><button data-a="restart">${won ? 'PLAY AGAIN' : 'RETRY'}</button></div>`;
    this.root.appendChild(this.overlay);
    this.overlay.querySelector('[data-a="restart"]')?.addEventListener('click', () => (window.__XANDRIA__ as any)?.engine.restart());
  }

  private clearOverlay() { this.overlay?.remove(); this.overlay = null; }
}
