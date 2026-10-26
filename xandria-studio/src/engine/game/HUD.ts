/**
 * DOM HUD overlay: health/boost bars, objective tracker, score, timer, crosshair,
 * damage vignette, pause + end screens. Zero three.js cost; crisp at any resolution.
 */
import type { GameSpec, NarrativeSpec } from '@spec';
import type { Engine } from '../Engine';
import type { UpgradeDef } from './Progression';
import type { DailyBoardRow } from './dailyChallenges';
import type { GauntletBoardRow } from './gauntlet';
/** UPGRADE LOOP (save-slots): title-screen slot picker rows. */
import type { SlotSummary } from './Profile';
/**
 * ACCESSIBILITY PASS: palette table + keybind helpers for the settings UI.
 * HUD chips read palette colors through CSS variables (see CSS above);
 * text scale sets inline font sizes on the primary readouts.
 */
import {
  COLORBLIND_PALETTES, THEME_TABLE, UI_REMAPPABLE_ACTIONS, keyDisplayName,
  themeVar, tryRemap, validateKeybinds,
  type AccessibilitySettings, type ColorblindPalette, type KeybindOverrides,
  type RemappableAction, type ThemeRole,
} from './accessibility';

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
  /**
   * Run-journal wave: observed per-run counts (optional). When present,
   * showEnd renders a RUN RECAP block with them.
   */
  deaths?: number;
  portals?: number;
  xpGained?: number;
  bossesKilled?: number;
  seed?: number;
  /**
   * UPGRADE LOOP (hardcore-ironman): this run was played in ironman mode.
   * showEnd renders the IRONMAN bonus bit in the recap when present.
   */
  ironman?: boolean;
  /** Score multiplier applied to a won ironman run (from the ironman table). */
  ironmanMult?: number;
  /**
   * UPGRADE LOOP (hardcore-ironman): this ironman run ended in death, so
   * the slot is permanently dead. showEnd renders the SLOT DEAD line and
   * hides RESTART (and any NG+ offer) — there is no respawn path.
   */
  ironmanDead?: boolean;
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
.xhud .objective .progress { font-size:15px; font-weight:700; color:var(--a11y-accent, #ffd23f); margin-top:4px; }
.xhud .score { top:16px; right:16px; text-align:right; }
.xhud .score .val { font-size:22px; font-weight:800; color:var(--a11y-accent, #ffd23f); }
.xhud .score .lbl { font-size:10px; letter-spacing:.18em; opacity:.7; }
/* vendor-economy wave: the scrap (currency) readout under the score */
.xhud .score .coinval { font-size:15px; font-weight:800; color:var(--a11y-coin, #8fe3a8); margin-top:4px; }
.xhud .timer { font-size:13px; opacity:.9; margin-top:4px; font-variant-numeric:tabular-nums; }
.xhud .lives { font-size:13px; margin-top:2px; color:var(--a11y-lives, #ff8a9a); }
/* WORLD-TIERS: map tier readout, hidden on tier 1 (origin / single-map games).
   Lives inside the score panel so it can't collide with the quest tracker
   (desktop tracker top is 136px; the panel stays ~123px tall with the chip). */
.xhud .tier { font-size:13px; margin-top:2px; color:var(--a11y-info, #7dd3fc); letter-spacing:.12em; font-weight:700; }
.xhud .ngplus { font-size:13px; margin-top:2px; color:#fbbf24; letter-spacing:.12em; font-weight:700; }
/* hardcore-ironman wave: the ironman chip in the score panel, same event-driven pattern as .ngplus */
.xhud .ironman { font-size:13px; margin-top:2px; color:#ff5a5a; letter-spacing:.12em; font-weight:700; }
.xhud .crosshair { position:absolute; left:50%; top:50%; width:14px; height:14px; transform:translate(-50%,-50%); }
.xhud .crosshair::before, .xhud .crosshair::after { content:''; position:absolute; background:rgba(240,250,255,.9); }
.xhud .crosshair::before { left:6px; top:0; width:2px; height:14px; }
.xhud .crosshair::after { left:0; top:6px; width:14px; height:2px; }
.xhud .vignette { position:absolute; inset:0; background:radial-gradient(ellipse at center, transparent 55%, rgba(255,30,40,.55) 100%); opacity:0; transition:opacity .1s; }
.xhud .toast { position:absolute; left:50%; top:18%; transform:translateX(-50%); font-size:20px; font-weight:700; letter-spacing:.1em; text-shadow:0 2px 12px rgba(0,0,0,.7); opacity:0; transition:opacity .3s; }
.xhud .hint { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); font-size:11.5px; opacity:.65; background:rgba(10,14,20,.5); padding:6px 12px; border-radius:8px; }
/* HUD-polish: an empty hint is a visible padding-only pill — hide it so it
   can't collide with the bars on touch layouts. */
.xhud .hint:empty { display:none; }
/* Tutorial wave: the guided first-run card. Amber pulse ring is the HUD
   highlight; the Skip button dismisses permanently (Profile.tutorialSeen). */
.xhud .tutcard { position:absolute; left:50%; bottom:64px; transform:translateX(-50%); max-width:min(480px,92vw);
  background:rgba(8,10,16,.92); border:1px solid #ffb545; border-radius:12px; padding:10px 14px 12px;
  font-family:system-ui,-apple-system,sans-serif; color:#e8ecf4; text-align:center; z-index:9400;
  pointer-events:none; /* only the Skip button takes clicks (button rule below) — the card body must never cover settings/pause buttons (MERGE: tutorial card used to intercept them) */
  animation:tutpulse 1.6s ease-in-out infinite; }
.xhud .tutcard .tutlabel { font-size:10px; letter-spacing:.18em; color:#ffb545; font-weight:700; margin-bottom:4px; }
.xhud .tutcard .tutprompt { font-size:15px; font-weight:600; margin-bottom:8px; }
.xhud .tutcard button { pointer-events:auto; font-size:11px; letter-spacing:.1em; color:#9aa4b8; background:transparent;
  border:1px solid rgba(154,164,184,.4); border-radius:6px; padding:4px 10px; cursor:pointer; }
.xhud .tutcard button:hover { color:#e8ecf4; border-color:#e8ecf4; }
@keyframes tutpulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,181,69,.45); } 50% { box-shadow:0 0 0 7px rgba(255,181,69,0); } }
/* Optional per-step target highlight (TutorialStepDef.hudTarget). */
.xhud .tuthl { animation:tutpulse 1.6s ease-in-out infinite; border-color:#ffb545 !important; }
.xhud .overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(6,8,14,.72); backdrop-filter:blur(6px); pointer-events:auto; }
.xhud .overlay h1 { font-size:44px; letter-spacing:.14em; margin:0 0 8px; }
.xhud .overlay .sub { font-size:15px; opacity:.85; margin-bottom:6px; }
.xhud .overlay .stats { font-size:13px; opacity:.7; margin-bottom:26px; font-variant-numeric:tabular-nums; }
/* run-journal wave: the recap block on the end screen, and the journal
   button row on the title screen */
.xhud .overlay .recap { border-top:1px solid rgba(140,180,220,.25); padding-top:12px; margin-top:-14px; font-size:12px; letter-spacing:.04em; }
.xhud .title-screen .journal-row { margin-top:14px; }
.xhud .title-screen .journal-btn { font-size:14px; padding:10px 26px; }
.xhud .overlay button { pointer-events:auto; cursor:pointer; font-size:15px; font-weight:600; letter-spacing:.08em; padding:12px 34px; border-radius:10px; border:1px solid rgba(140,180,220,.4); background:linear-gradient(180deg,#2b3f57,#1a2536); color:#e8ecf1; margin:4px; }
.xhud .overlay button:hover { background:linear-gradient(180deg,#3a5474,#223048); }
.xhud .boss { position:absolute; left:50%; top:56px; transform:translateX(-50%); width:340px; text-align:center; }
.xhud .boss .bar { height:10px; }
.xhud .boss .name { font-size:12px; letter-spacing:.2em; opacity:.85; margin-bottom:4px; }
.xhud .card { position:absolute; left:50%; top:13%; transform:translateX(-50%); max-width:440px; width:calc(100% - 48px); padding:18px 24px 20px; background:rgba(10,14,20,.9); border:1px solid rgba(255,210,63,.4); border-radius:12px; backdrop-filter:blur(6px); pointer-events:auto; text-align:center; animation:cardin .25s ease; cursor:pointer; }
.xhud .card h2 { font-size:19px; letter-spacing:.14em; margin:0 0 8px; color:var(--a11y-accent, #ffd23f); }
.xhud .card p { font-size:13.5px; opacity:.92; line-height:1.6; margin:0 0 14px; }
.xhud .card .btn { display:inline-block; font-size:13px; font-weight:700; letter-spacing:.1em; padding:9px 26px; border-radius:8px; border:1px solid rgba(140,180,220,.4); background:linear-gradient(180deg,#2b3f57,#1a2536); color:#e8ecf1; cursor:pointer; }
.xhud .lvlopts { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; justify-content:center; }
.xhud .lvlopt { flex:1 1 150px; max-width:210px; padding:14px 12px; border-radius:10px; border:1px solid rgba(140,180,220,.35); background:linear-gradient(180deg,#223048,#141c2c); color:#e8ecf1; cursor:pointer; text-align:center; }
.xhud .lvlopt:hover { border-color:#ffd23f; background:linear-gradient(180deg,#2e4258,#1a2438); }
.xhud .lvlopt .nm { font-size:14px; font-weight:700; letter-spacing:.06em; color:var(--a11y-accent, #ffd23f); margin-bottom:6px; }
.xhud .lvlopt .ds { font-size:12px; opacity:.8; line-height:1.45; }
.xhud .title-screen { background:rgba(4,6,10,.62); }
/* MERGE (save-slots x gauntlet/journal): the merged title screen is taller
 * than the viewport (boards + journal), and a centered flex column clips
 * its TOP with no scroll — the slot picker sat above the viewport. Safe
 * center falls back to top alignment on overflow, and the overlay scrolls
 * so the bottom stays reachable. */
.xhud .overlay.title-screen { overflow-y:auto; justify-content:safe center; }
.xhud .title-screen .tag { font-size:13px; letter-spacing:.5em; opacity:.6; margin-bottom:10px; }
.xhud .title-screen h1 { font-size:52px; }
.xhud .title-screen .premise { max-width:520px; font-size:15px; line-height:1.65; opacity:.92; margin:0 24px 18px; text-align:center; }
.xhud .title-screen .controls { display:flex; flex-wrap:wrap; gap:6px 18px; justify-content:center; max-width:520px; font-size:12px; opacity:.65; margin-bottom:26px; }
.xhud .title-screen .start-btn { font-size:18px; padding:14px 44px; animation:pulse 1.6s ease-in-out infinite; }
.xhud .title-screen .profile-line { font-size:12px; letter-spacing:.08em; opacity:.7; margin:-8px 0 14px; }
.xhud .title-screen .merit-line { font-size:13px; letter-spacing:.08em; color:var(--a11y-accent, #ffd23f); margin-bottom:10px; }
.xhud .title-screen .mods { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; max-width:560px; margin-bottom:14px; }
.xhud .title-screen .mod { pointer-events:auto; border:1px solid rgba(140,180,220,.35); border-radius:8px; padding:8px 10px; font-size:11px; text-align:center; min-width:110px; max-width:130px; background:rgba(20,28,44,.7); cursor:pointer; }
.xhud .title-screen .mod .mn { font-weight:700; letter-spacing:.05em; margin-bottom:3px; }
.xhud .title-screen .mod .md { opacity:.75; line-height:1.4; margin-bottom:5px; }
.xhud .title-screen .mod .ma { font-size:10px; letter-spacing:.08em; color:#ffd23f; }
.xhud .title-screen .mod.equipped { border-color:#ffd23f; background:rgba(60,48,16,.6); }
.xhud .title-screen .mod.locked { opacity:.55; cursor:pointer; }
/* N10: unaffordable purchase attempt — shake + red flash on the mod card */
.xhud .title-screen .mod.denied { border-color:#ff6a7a; animation:deny-shake .45s ease; }
@keyframes deny-shake { 0%,100% { transform:translateX(0); } 20% { transform:translateX(-6px); } 40% { transform:translateX(5px); } 60% { transform:translateX(-4px); } 80% { transform:translateX(3px); } }
.xhud .title-screen .daily-row { display:flex; gap:12px; align-items:center; justify-content:center; margin-bottom:14px; flex-wrap:wrap; }
/* gauntlet mode: same row/board language as the daily challenge */
.xhud .title-screen .gauntlet-row { display:flex; gap:12px; align-items:center; justify-content:center; margin-bottom:14px; flex-wrap:wrap; }
.xhud .title-screen .gauntlet-btn { font-size:14px; padding:10px 26px; border-color:rgba(255,120,60,.55); }
.xhud .title-screen .gauntlet-line { font-size:12px; opacity:.75; letter-spacing:.06em; }
.xhud .title-screen .gauntlet-board { margin:0 auto 18px; max-width:560px; width:min(94%,560px); border:1px solid rgba(255,150,80,.25); border-radius:10px; padding:10px 14px; background:rgba(26,14,8,.55); font-size:12px; }
.xhud .title-screen .gauntlet-board-head { font-size:11px; letter-spacing:.22em; opacity:.65; margin-bottom:8px; text-align:center; }
.xhud .title-screen .gauntlet-board-row { display:flex; gap:10px; align-items:baseline; padding:3px 0; border-top:1px solid rgba(255,150,80,.12); }
.xhud .title-screen .gauntlet-board-row:first-of-type { border-top:none; }
.xhud .title-screen .gauntlet-board-row.today .gbr-date { color:#ffd23f; font-weight:700; }
.xhud .title-screen .gbr-date { width:64px; flex:none; opacity:.8; letter-spacing:.08em; }
.xhud .title-screen .gbr-bosses { flex:1; opacity:.85; }
.xhud .title-screen .gbr-result { flex:none; opacity:.9; text-align:right; }

.xhud .title-screen .daily-btn { font-size:14px; padding:10px 26px; }
.xhud .title-screen .daily-btn.played { opacity:.55; cursor:default; }
.xhud .title-screen .daily-challenge-line { font-size:12px; opacity:.75; letter-spacing:.06em; }
.xhud .title-screen .daily-board { margin:0 auto 18px; max-width:520px; width:min(92%,520px); border:1px solid rgba(140,180,220,.25); border-radius:10px; padding:10px 14px; background:rgba(10,16,26,.55); font-size:12px; }
.xhud .title-screen .daily-board-head { font-size:11px; letter-spacing:.22em; opacity:.65; margin-bottom:8px; text-align:center; }
.xhud .title-screen .daily-board-row { display:flex; gap:10px; align-items:baseline; padding:3px 0; border-top:1px solid rgba(140,180,220,.12); }
.xhud .title-screen .daily-board-row:first-of-type { border-top:none; }
.xhud .title-screen .daily-board-row.today .dbr-date { color:var(--a11y-accent, #ffd23f); font-weight:700; }
.xhud .title-screen .dbr-date { width:64px; flex:none; opacity:.8; letter-spacing:.08em; }
.xhud .title-screen .dbr-goal { flex:1; opacity:.85; }
.xhud .title-screen .dbr-result { flex:none; opacity:.9; text-align:right; }
/* UPGRADE LOOP (save-slots): title-screen slot picker. All interactive
   targets >= 28px (skills-wave touch precedent); the picker must fit 360px. */
.xhud .title-screen .slots { width:min(92%,460px); box-sizing:border-box; margin:0 auto 14px; border:1px solid rgba(140,180,220,.25); border-radius:10px; padding:10px 12px; background:rgba(10,16,26,.55); }
.xhud .title-screen .slots-head { font-size:11px; letter-spacing:.22em; opacity:.65; margin-bottom:8px; text-align:center; }
.xhud .title-screen .slot-row { display:flex; gap:6px; align-items:stretch; margin-bottom:6px; }
.xhud .title-screen .slot-row:last-of-type { margin-bottom:2px; }
.xhud .title-screen .slot-pick { flex:1; min-width:0; display:flex; align-items:center; gap:10px; min-height:36px; padding:6px 12px; border-radius:8px; border:1px solid rgba(140,180,220,.3); background:rgba(20,28,44,.7); color:#e8ecf1; cursor:pointer; text-align:left; font-size:13px; margin:0; }
.xhud .title-screen .slot-pick .slot-name { font-weight:700; letter-spacing:.04em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.xhud .title-screen .slot-pick .slot-meta { font-size:11px; opacity:.7; overflow-wrap:anywhere; }
.xhud .title-screen .slot-row.active .slot-pick { border-color:#ffd23f; background:rgba(60,48,16,.6); }
.xhud .title-screen .slot-row.active .slot-name::before { content:'▸ '; color:#ffd23f; }
/* hardcore-ironman wave: dead slots read as dead at a glance; ironman slots are marked */
.xhud .title-screen .slot-row.dead .slot-pick { border-color:#ff5a5a; opacity:.75; }
.xhud .title-screen .slot-row.dead .slot-name { color:#ff8a8a; }
.xhud .title-screen .slot-row.ironman:not(.dead) .slot-pick { border-color:#ff8a5a; }
/* hardcore-ironman wave: mode picker + confirm step + dead-slot notice */
.xhud .title-screen .mode-picker { width:min(92%,460px); box-sizing:border-box; margin:0 auto 14px; text-align:center; }
.xhud .title-screen .mode-label { font-size:11px; letter-spacing:.22em; opacity:.65; margin-right:10px; }
.xhud .title-screen .slot-dead-notice { width:min(92%,460px); box-sizing:border-box; margin:0 auto 14px; text-align:center; font-size:13px; letter-spacing:.06em; color:#ff8a8a; border:1px solid rgba(255,90,90,.5); border-radius:10px; padding:10px 12px; background:rgba(60,10,10,.55); }
.xhud .title-screen .ironman-confirm { margin-top:10px; border:1px solid rgba(255,138,90,.5); border-radius:10px; padding:10px 12px; background:rgba(60,20,10,.55); }
.xhud .title-screen .ironman-confirm-text { font-size:13px; line-height:1.5; margin-bottom:8px; }
.xhud .overlay .ironman-dead { font-size:14px; letter-spacing:.08em; color:#ff8a8a; margin-bottom:26px; }
.xhud .title-screen .slot-btn { min-width:36px; min-height:36px; padding:4px 8px; border-radius:8px; border:1px solid rgba(140,180,220,.3); background:rgba(20,28,44,.7); color:#e8ecf1; cursor:pointer; font-size:14px; margin:0; }
.xhud .title-screen .slot-btn:disabled { opacity:.35; cursor:default; }
.xhud .title-screen .slot-btn.armed { border-color:#ff6a7a; color:#ff8a9a; }
.xhud .title-screen .slot-rename-input { flex:1; min-height:36px; min-width:0; background:#141c2c; color:#e8ecf1; border:1px solid #ffd23f; border-radius:8px; padding:6px 10px; font-size:14px; }
.xhud .title-screen .slot-new { width:100%; min-height:36px; margin:4px 0 0; border-radius:8px; border:1px dashed rgba(140,180,220,.4); background:transparent; color:#9fb4d0; cursor:pointer; font-size:13px; letter-spacing:.1em; padding:6px 12px; }
@keyframes pulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.05); } }
.xhud .settings { display:flex; flex-direction:column; gap:14px; margin-bottom:24px; min-width:300px; }
/* UPGRADE LOOP (audio-system): the settings panel outgrew the viewport
   (volume, quality, tier, difficulty, mute, audio buses, colorblind,
   motion, text size, keybinds) — a centered overflow:hidden overlay
   clipped the lower rows off-screen and made them unclickable. The
   settings view scrolls from the top instead; other overlays keep the
   centered layout (title-screen already scrolls via its own rule). */
.xhud .overlay.settings-view { overflow-y:auto; justify-content:flex-start; }
.xhud .settings-row { display:flex; align-items:center; gap:14px; font-size:13px; letter-spacing:.1em; }
.xhud .settings-row span { width:110px; text-align:right; opacity:.8; }
.xhud .settings-row input[type=range] { flex:1; accent-color:#ffd23f; min-height:28px; }
.xhud .settings-row select { flex:1; background:#1a2536; color:#e8ecf1; border:1px solid rgba(140,180,220,.4); border-radius:8px; padding:8px 10px; font-size:13px; }
/* UPGRADE LOOP (audio-system): settings toggles meet the 28px touch target
   floor (skills-wave precedent, asserted in audio-system e2e). */
.xhud .settings-row input[type=checkbox] { width:28px; height:28px; accent-color:#ffd23f; }
@keyframes cardin { from { opacity:0; transform:translate(-50%,-10px); } }
/* touch mode: keep HUD clear of the joystick (bottom-left) and buttons (bottom-right) */
.xhud.touch .bars { left:12px; bottom:200px; width:190px; }
/* HUD-polish: the old bottom:210px landed the hint on the bars (bottom:200px,
   ~61px tall on small screens) — 270px clears them with margin. */
.xhud.touch .hint { bottom:270px; }
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
/* HUD-polish: while a boss bar is up on narrow screens, the centered bar
   (top:48px, up to 70vw wide) paints over the objective and score panels.
   Shift the top cluster down 36px for the fight's duration (setBoss toggles
   .xboss on the engine container; the tracker shift lives in QuestTracker's
   own stylesheet; the touch pause button re-measures via
   repositionPauseButton). Desktop is untouched — no collision there. */
@media (max-width:760px) {
  .xboss .xhud .objective { top:max(48px, calc(env(safe-area-inset-top) + 36px)); }
  .xboss .xhud .score { top:max(48px, calc(env(safe-area-inset-top) + 36px)); }
  .xboss .xhud .boss { top:8px; }
}
`;

/**
 * HUD-polish wave: the blocking-modal layer. Level-up / branch-choice modals
 * used to be appended to .xhud (z-index 10), whose stacking context trapped
 * them UNDER the quest dialogue panel (z-index 9500) — on mobile the dialogue
 * covered the modal and its upgrade buttons were unclickable. The modals now
 * live in this dedicated layer, a direct child of the engine container, above
 * the dialogue (9500) and the crafting panel (9600), below the engine debug
 * overlay / splash (99998+). Only the two blocking modals (N5) move here;
 * title / pause / end screens and story cards stay in .xhud untouched.
 * The overlay rules below mirror .xhud .overlay so the modals look identical.
 */
const MODAL_CSS = `
.xhud-modals { position:absolute; inset:0; z-index:9650; pointer-events:none; }
.xhud-modals .overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(6,8,14,.72); backdrop-filter:blur(6px); pointer-events:auto; }
.xhud-modals .overlay h1 { font-size:44px; letter-spacing:.14em; margin:0 0 8px; }
.xhud-modals .overlay .sub { font-size:15px; opacity:.85; margin-bottom:6px; }
.xhud-modals .lvlopts { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; justify-content:center; }
.xhud-modals .lvlopt { flex:1 1 150px; max-width:210px; padding:14px 12px; border-radius:10px; border:1px solid rgba(140,180,220,.35); background:linear-gradient(180deg,#223048,#141c2c); color:#e8ecf1; cursor:pointer; text-align:center; font-family:inherit; }
.xhud-modals .lvlopt:hover { border-color:#ffd23f; background:linear-gradient(180deg,#2e4258,#1a2438); }
.xhud-modals .lvlopt .nm { font-size:14px; font-weight:700; letter-spacing:.06em; color:var(--a11y-accent, #ffd23f); margin-bottom:6px; }
.xhud-modals .lvlopt .ds { font-size:12px; opacity:.8; line-height:1.45; }
@media (max-width:760px) {
  .xhud-modals .overlay h1 { font-size:32px; }
}
`;

/**
 * N5: a live level-up / branch-choice modal tracked by the HUD so teardown
 * can dismiss it — removes the element AND the document keydown listener,
 * then settles the promise (no stale modal callbacks after restart).
 */
interface ActiveModal {
  el: HTMLDivElement;
  onKey: ((e: KeyboardEvent) => void) | null;
  /** resolve/abandon the modal's promise after teardown detached it */
  settle: () => void;
}

/**
 * R4-M1: sentinel resolving a branch-choice promise when its modal is torn
 * down without a player pick (restart / clearOverlays). Objectives releases
 * `awaitingChoice` on this value instead of advancing — the run is being
 * rebuilt or is dead, so there is nothing to advance to.
 */
export const CHOICE_ABANDONED = -1;

export class HUD {
  private root: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private boostFill: HTMLDivElement;
  private objTitle: HTMLDivElement;
  private objDesc: HTMLDivElement;
  private objProg: HTMLDivElement;
  private scoreVal: HTMLDivElement;
  private coinVal: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private livesEl: HTMLDivElement;
  private vignette: HTMLDivElement;
  private toastEl: HTMLDivElement;
  /** Tutorial wave: the live tutorial card + highlighted target (if any). */
  private tutCard: HTMLDivElement | null = null;
  private tutHl: HTMLElement | null = null;
  private crosshair: HTMLDivElement;
  private overlay: HTMLDivElement | null = null;
  /** live story card from showCard (tracked so restarts can dismiss it) */
  private card: HTMLDivElement | null = null;
  /**
   * N5: live level-up / branch-choice modal, tracked so clearOverlays() can
   * dismiss it on teardown/restart — removes the element AND the document
   * keydown listener, then settles the promise (no stale modal callbacks).
   */
  private activeModal: ActiveModal | null = null;
  /**
   * R4-M1: queue of modal-show closures waiting behind the active blocking
   * modal. A level-up earned on the same tick as a branch choice must not
   * preempt the choice modal (preemption used to abandon the choice, resume
   * the game, and leave Objectives.awaitingChoice true forever — a run
   * soft-lock). Queued modals show in order as each modal closes normally;
   * the queue is dropped on clearOverlays (teardown/restart).
   */
  private modalQueue: Array<() => void> = [];
  /**
   * HUD-polish wave: dedicated layer for the blocking modals (level-up /
   * branch choice), appended to the engine container (NOT .xhud) at
   * z-index 9650 — above the dialogue (9500) and crafting panel (9600).
   */
  private modalLayer: HTMLDivElement;
  private boostBar: HTMLDivElement;
  private vignetteT = 0;
  private toastT = 0;
  private lowHp = false;
  private hintEl: HTMLDivElement;
  private bossEl: HTMLDivElement;
  private bossName: HTMLDivElement;
  private bossFill: HTMLDivElement;
  /**
   * WORLD-TIERS: map tier readout in the score panel. Hidden at tier 1
   * (origin / single-map games) so the common case renders exactly as
   * before. Updated ONLY via setTier (engine calls it on boot + portal
   * arrival) — zero per-frame cost; update() never touches it.
   */
  private tierEl: HTMLDivElement;
  /**
   * UPGRADE LOOP (new-game-plus): NG+ cycle chip in the score panel.
   * Hidden at cycle 0 (the base game) so the common case renders exactly
   * as before. Updated ONLY via setNgPlus (engine calls it on run start
   * and on NG+ entry) — zero per-frame cost; update() never touches it.
   * The last value is cached so repeat calls with the same cycle are a
   * no-op, not even a style write.
   */
  private ngplusEl: HTMLDivElement;
  private lastNgPlus = -1;
  /**
   * UPGRADE LOOP (hardcore-ironman): IRONMAN chip in the score panel.
   * Mirrors setNgPlus exactly: hidden when inactive (the common case),
   * updated ONLY via setIronman (engine calls it on run start, on title,
   * and on boot) — zero per-frame cost; update() never touches it.
   * Repeat calls with the same value are a cached no-op.
   */
  private ironmanEl: HTMLDivElement;
  private lastIronman: boolean | null = null;

  constructor(private container: HTMLElement, private spec: GameSpec) {
    const style = document.createElement('style');
    style.textContent = CSS + MODAL_CSS;
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
        <div class="coinval">0</div>
        <div class="lbl">SCRAP</div>
        <div class="timer"></div>
        <div class="lives"></div>
        <div class="tier" style="display:none"></div>
        <div class="ngplus" style="display:none"></div>
        <div class="ironman" style="display:none"></div>
      </div>
      <div class="vignette"></div>
      <div class="toast"></div>
      <div class="hint"></div>
      <div class="boss" style="display:none"><div class="name"></div><div class="bar"><div style="width:100%"></div></div></div>`;
    container.style.position = 'relative';
    container.appendChild(this.root);
    // HUD-polish wave: the blocking-modal layer (z 9650) sits in the engine
    // container, outside .xhud's z-10 stacking context, so modals paint
    // above the dialogue panel (9500) and crafting panel (9600).
    this.modalLayer = document.createElement('div');
    this.modalLayer.className = 'xhud-modals';
    container.appendChild(this.modalLayer);

    this.hpFill = this.root.querySelector('.hp > div')!;
    this.boostBar = this.root.querySelector('.boost')!;
    this.boostFill = this.root.querySelector('.boost > div')!;
    this.objTitle = this.root.querySelector('.objective .title')!;
    this.objDesc = this.root.querySelector('.objective .desc')!;
    this.objProg = this.root.querySelector('.objective .progress')!;
    this.scoreVal = this.root.querySelector('.score .val')!;
    this.coinVal = this.root.querySelector('.score .coinval')!;
    this.timerEl = this.root.querySelector('.timer')!;
    this.livesEl = this.root.querySelector('.lives')!;
    this.vignette = this.root.querySelector('.vignette')!;
    this.toastEl = this.root.querySelector('.toast')!;
    this.hintEl = this.root.querySelector('.hint')!;
    this.bossEl = this.root.querySelector('.boss')!;
    this.bossName = this.root.querySelector('.boss .name')!;
    this.bossFill = this.root.querySelector('.boss .bar > div')!;
    this.tierEl = this.root.querySelector('.score .tier')!;
    this.ngplusEl = this.root.querySelector('.score .ngplus')!;
    this.ironmanEl = this.root.querySelector('.score .ironman')!;
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

  /**
   * ACCESSIBILITY PASS: apply palette + text scale. Palette colors land
   * as CSS variables on the HUD root (chips read them via var() with the
   * shipped hex as fallback, so pre-apply rendering is unchanged); text
   * scale sets inline font sizes on the primary readouts (base px sizes
   * from the stylesheet × scale, rounded to 0.1px). Inline sizes beat the
   * small-screen media-query sizes — a deliberate tradeoff: a user who
   * asked for bigger text gets it on every viewport. Panels owned by
   * other UI classes (inventory, crafting, dialogue) are NOT scaled here.
   */
  applyAccessibility(palette: ColorblindPalette, textScale: number): void {
    const table = THEME_TABLE[palette];
    (Object.keys(table) as ThemeRole[]).forEach((role) => {
      this.root.style.setProperty(themeVar(role), table[role]);
    });
    const px = (base: number) => `${Math.round(base * textScale * 10) / 10}px`;
    this.objTitle.style.fontSize = px(13);
    this.objDesc.style.fontSize = px(12);
    this.objProg.style.fontSize = px(15);
    this.scoreVal.style.fontSize = px(22);
    this.coinVal.style.fontSize = px(15);
    this.timerEl.style.fontSize = px(13);
    this.livesEl.style.fontSize = px(13);
    this.tierEl.style.fontSize = px(13);
    this.toastEl.style.fontSize = px(20);
    this.hintEl.style.fontSize = px(11.5);
    this.bossName.style.fontSize = px(12);
  }
  setProgress(text: string) { this.objProg.textContent = text; }
  setScore(v: number) { this.scoreVal.textContent = String(Math.round(v)); }
  /** vendor-economy wave: the scrap (currency) readout under the score. */
  setCurrency(n: number) { this.coinVal.textContent = String(Math.max(0, Math.floor(n))); }
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
  /**
   * WORLD-TIERS: set the map tier chip. Tier <= 1 hides the chip (the
   * common case). Called by the engine on boot and portal arrival only —
   * never per frame.
   */
  setTier(tier: number) {
    const t = Number.isFinite(tier) ? Math.max(1, Math.floor(tier)) : 1;
    if (t <= 1) {
      this.tierEl.style.display = 'none';
      this.tierEl.textContent = '';
    } else {
      this.tierEl.style.display = '';
      this.tierEl.textContent = `TIER ${t}`;
    }
  }
  /**
   * UPGRADE LOOP (new-game-plus): set the NG+ cycle chip. Cycle <= 0
   * hides the chip (the base game). Called by the engine on run start
   * and on NG+ entry only — never per frame; same-cycle calls no-op.
   */
  setNgPlus(cycle: number) {
    const c = Number.isFinite(cycle) ? Math.max(0, Math.floor(cycle)) : 0;
    if (c === this.lastNgPlus) return;
    this.lastNgPlus = c;
    if (c <= 0) {
      this.ngplusEl.style.display = 'none';
      this.ngplusEl.textContent = '';
    } else {
      this.ngplusEl.style.display = '';
      this.ngplusEl.textContent = `NG+ ${c}`;
    }
  }
  /**
   * UPGRADE LOOP (hardcore-ironman): set the IRONMAN chip. Inactive
   * hides it (the common case). Same cached no-op shape as setNgPlus.
   */
  setIronman(active: boolean) {
    const on = active === true;
    if (on === this.lastIronman) return;
    this.lastIronman = on;
    if (!on) {
      this.ironmanEl.style.display = 'none';
      this.ironmanEl.textContent = '';
    } else {
      this.ironmanEl.style.display = '';
      this.ironmanEl.textContent = 'IRONMAN';
    }
  }
  setCrosshair(show: boolean) { this.crosshair.style.display = show ? '' : 'none'; }
  setHint(text: string) { this.hintEl.textContent = text; }
  /** Boss health bar. Pass null to hide. */
  setBoss(name: string | null, frac: number) {
    if (name === null) {
      this.bossEl.style.display = 'none';
      // HUD-polish: boss-fight layout shift over (see CSS .xboss rules).
      // Defensive ?. — minimal DOM stubs may not implement classList.
      this.container.classList?.remove('xboss');
      this.eng?.touch?.repositionPauseButton();
      return;
    }
    this.bossEl.style.display = '';
    this.bossName.textContent = name;
    this.bossFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    // HUD-polish: on narrow screens the centered boss bar collides with the
    // objective/score panels — .xboss shifts the top cluster down for the
    // fight's duration (mobile-only rules; desktop untouched). The shift
    // moves the score/tracker the touch pause button clears, so re-run its
    // layout (no-op when touch is inactive or eng is a test stub).
    // Defensive ?. — minimal DOM stubs may not implement classList.
    this.container.classList?.add('xboss');
    this.eng?.touch?.repositionPauseButton();
  }

  /** Engine reference for modal flows (level-up pause). Set by Engine. */
  private eng: Engine | null = null;
  attachEngine(e: Engine) {
    this.eng = e;
  }

  /**
   * N5: modal bookkeeping. trackModal registers a newly opened modal
   * (abandoning any previous one first — double-opens shouldn't happen, but
   * must never leak). detachModal removes the element + document keydown
   * listener without settling (the normal pick path settles itself).
   * abandonModal is the teardown path: detach, then settle the promise.
   */
  private trackModal(m: ActiveModal) {
    // R5-N1: only abandon when something is actually tracked. pumpModalQueue
    // surfaces queued modals through trackModal, and the old unconditional
    // abandon wiped the rest of the queue (dropped promises never settled).
    if (this.activeModal) this.abandonModal();
    this.activeModal = m;
  }

  private detachModal() {
    const m = this.activeModal;
    this.activeModal = null;
    if (!m) return;
    if (m.onKey) document.removeEventListener('keydown', m.onKey);
    m.el.remove();
  }

  private abandonModal() {
    const m = this.activeModal;
    // R4-M1: an abandoned modal's context is dead — queued modals from that
    // context must not surface afterwards.
    this.modalQueue.length = 0;
    this.detachModal();
    m?.settle();
  }

  /**
   * R4-M1: show the next queued modal, if any, after a modal closes normally.
   * Never called from abandon/teardown paths — those drop the queue instead
   * (see clearOverlays), so a level-up earned in a dead run can't pop over
   * the new run's UI.
   */
  private pumpModalQueue() {
    if (this.activeModal) return;
    const next = this.modalQueue.shift();
    next?.();
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
    this.card?.remove();
    this.card = null;
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
        if (this.card === el) this.card = null;
        resolve();
      };
      el.addEventListener('click', finish);
      this.root.appendChild(el);
      this.card = el;
      const timer = setTimeout(finish, 3500);
    });
  }

  /**
   * Level-up modal — PAUSES the game until the player picks one of the
   * 3 upgrade choices. Resolves with the chosen upgrade id.
   */
  showLevelUp(choices: UpgradeDef[]): Promise<string> {
    const eng = this.eng;
    // N6: the kill that levels up may also win/lose the run (grantKillXp runs
    // before addProgress now, and the notify chain is async) — never pop the
    // modal over the end screen; grant the first upgrade silently instead.
    if (eng && (eng.state === 'won' || eng.state === 'lost')) {
      return Promise.resolve(choices[0]?.id ?? '');
    }
    // R4-M1: never preempt a live blocking modal. A level-up earned on the
    // same tick as a branch choice queues behind the choice modal and shows
    // once the player picks a path (pumpModalQueue). Preemption used to
    // abandon the choice, resume the game, and freeze quest progress forever.
    if (this.activeModal) {
      return new Promise<string>((resolve) => {
        this.modalQueue.push(() => this.showLevelUpNow(choices, resolve));
      });
    }
    return new Promise<string>((resolve) => this.showLevelUpNow(choices, resolve));
  }

  /** The actual level-up modal. Separated so queued level-ups show later. */
  private showLevelUpNow(choices: UpgradeDef[], resolve: (id: string) => void): void {
    const eng = this.eng;
    // A queued level-up can surface after the run ended — grant silently.
    if (eng && (eng.state === 'won' || eng.state === 'lost')) {
      resolve(choices[0]?.id ?? '');
      this.pumpModalQueue();
      return;
    }
    const pausing = eng?.state === 'playing';
    if (pausing) eng!.pause();
    {
      let done = false;
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
      const finish = (id: string) => {
        if (done) return;
        done = true;
        this.detachModal();
        if (pausing) eng!.resume();
        resolve(id);
        // R4-M1: a further level-up may be queued behind this one.
        this.pumpModalQueue();
      };
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
        b.addEventListener('click', () => finish(c.id));
        opts.appendChild(b);
      }
      el.append(h, sub, opts);
      // HUD-polish wave: blocking modals go to the dedicated modal layer
      // (z 9650, above the dialogue) — never to .xhud (z 10), whose stacking
      // context trapped them under the dialogue panel.
      this.modalLayer.appendChild(el);
      // N5: track the modal so clearOverlays() can dismiss + settle it on
      // teardown/restart. Settling with '' abandons the pending upgrade —
      // applyUpgrade('') is a harmless no-op, so no stale click can mutate
      // the (shared) spec after the run is gone.
      this.trackModal({ el, onKey: null, settle: () => finish('') });
    }
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
        this.detachModal();
        if (wasPlaying) eng!.resume();
        resolve(i);
        // R4-M1: a level-up earned on the branch-completing tick queues
        // behind this modal — show it now that the path is chosen.
        this.pumpModalQueue();
      };
      const abandon = () => {
        if (done) return;
        done = true;
        this.detachModal();
        if (wasPlaying) eng?.resume();
        // R4-M1: settle with the abandoned sentinel instead of leaving the
        // promise pending forever — Objectives releases awaitingChoice on
        // CHOICE_ABANDONED without advancing (the run is being torn down).
        resolve(CHOICE_ABANDONED);
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
      // HUD-polish wave: blocking modals go to the dedicated modal layer
      // (z 9650, above the dialogue) — never to .xhud (z 10).
      this.modalLayer.appendChild(el);
      document.addEventListener('keydown', onKey);
      // N5: track the element + keydown listener so clearOverlays() removes
      // them on teardown/restart. R4-M1: the settle resolves with
      // CHOICE_ABANDONED (see abandon above) — Objectives releases
      // awaitingChoice on the sentinel instead of advancing, so a torn-down
      // choice can never freeze the quest sequencer.
      this.trackModal({ el, onKey, settle: abandon });
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

  /**
   * Tutorial wave: show the guided first-run card (label like
   * "STEP 2/7 — LOOK", the step prompt, and a Skip button). `target` is an
   * optional HUD selector to pulse-highlight while the step is active.
   * Re-showing replaces the previous card; hideTutorialCard() removes it.
   */
  showTutorialCard(label: string, prompt: string, target: string | null, onSkip: () => void) {
    this.hideTutorialCard();
    // Headless/stub-DOM test harnesses fake `document` without ownerDocument:
    // track the tutorial state in the manager, skip rendering the card here.
    const doc = this.root?.ownerDocument;
    if (!doc) return;
    const card = doc.createElement('div');
    card.className = 'tutcard';
    const lab = doc.createElement('div');
    lab.className = 'tutlabel';
    lab.textContent = label;
    const pr = doc.createElement('div');
    pr.className = 'tutprompt';
    pr.textContent = prompt;
    const skip = doc.createElement('button');
    skip.type = 'button';
    skip.textContent = 'SKIP TUTORIAL';
    skip.addEventListener('click', (e) => { e.stopPropagation(); onSkip(); });
    card.append(lab, pr, skip);
    this.root.appendChild(card);
    this.tutCard = card;
    if (target) {
      const el = this.root.querySelector(target) as HTMLElement | null;
      if (el) {
        el.classList.add('tuthl');
        this.tutHl = el;
      }
    }
  }

  /** Tutorial wave: remove the tutorial card and any target highlight. */
  hideTutorialCard() {
    this.tutCard?.remove();
    this.tutCard = null;
    this.tutHl?.classList.remove('tuthl');
    this.tutHl = null;
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
    /** today already has a completed attempt — lock the button */
    dailyPlayed?: boolean;
    /** "Kill 40 enemies · Vitality + Power" line under the daily button */
    dailyChallengeLine?: string;
    /** today + previous 7 days, newest first */
    dailyBoard?: DailyBoardRow[];
    onDaily?: () => void;
    /** gauntlet mode (combat blueprints only): button label, e.g. "GAUNTLET 2026-10-23" */
    gauntletLabel?: string;
    /** boss order line under the gauntlet button, e.g. "WARDEN → TITAN → … · best 12,400" */
    gauntletLine?: string;
    /** today + previous 7 days of pinned gauntlets, newest first */
    gauntletBoard?: GauntletBoardRow[];
    onGauntlet?: () => void;
    /** UPGRADE LOOP (save-slots): title-screen slot picker rows */
    slots?: SlotSummary[];
    /** show the "+ NEW SLOT" button (false at the slot cap) */
    canNewSlot?: boolean;
    onSelectSlot?: (id: string) => void;
    onRenameSlot?: (id: string, name: string) => void;
    onDeleteSlot?: (id: string) => void;
    onNewSlot?: () => void;
    /** run-journal wave: opens the run journal panel; renders the button */
    onJournal?: () => void;
    /**
     * UPGRADE LOOP (character-customization): opens the customization
     * panel; renders the button next to the journal button.
     */
    onCustomize?: () => void;
    /** hardcore-ironman: the active slot is an ironman slot (picker label) */
    ironmanActive?: boolean;
    /** hardcore-ironman: the active slot is dead — start is blocked */
    slotDead?: boolean;
    /** hardcore-ironman: confirmed ironman start (after the confirm step) */
    onStartIronman?: () => void;
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

    // UPGRADE LOOP (save-slots): slot picker. Every control stopPropagation()s:
    // the overlay starts the run on any click, and touching a slot control is
    // not starting a run. Delete is two-step (arm → confirm) — WebView-safe,
    // no window.confirm. Rename is an inline input — no window.prompt.
    if (opts.slots && opts.slots.length) {
      const sw = document.createElement('div');
      sw.className = 'slots';
      const head = document.createElement('div');
      head.className = 'slots-head';
      head.textContent = 'SAVE SLOT';
      sw.appendChild(head);

      const startRename = (row: HTMLDivElement, s: SlotSummary, nm: HTMLSpanElement, renBtn: HTMLButtonElement) => {
        if (row.querySelector('input.slot-rename-input')) return; // already renaming
        const input = document.createElement('input');
        input.className = 'slot-rename-input';
        input.type = 'text';
        input.maxLength = 24;
        input.value = s.name;
        input.setAttribute('aria-label', `Rename slot ${s.name}`);
        input.addEventListener('click', (e) => e.stopPropagation());
        const cleanup = () => { input.replaceWith(nm); ok.remove(); };
        const commit = () => {
          const v = input.value.trim();
          cleanup();
          if (v) opts.onRenameSlot?.(s.id, v);
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cleanup();
        });
        const ok = document.createElement('button');
        ok.className = 'slot-btn slot-ok';
        ok.textContent = '✓';
        ok.setAttribute('aria-label', 'Confirm rename');
        ok.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
        nm.replaceWith(input);
        row.insertBefore(ok, renBtn);
        input.focus();
        input.select();
      };

      for (const s of opts.slots) {
        const row = document.createElement('div');
        row.className = 'slot-row' + (s.active ? ' active' : '')
          + (s.dead ? ' dead' : '') + (s.ironman && !s.dead ? ' ironman' : '');
        row.setAttribute('data-slot-id', s.id);
        const pick = document.createElement('button');
        pick.className = 'slot-pick';
        pick.setAttribute('aria-label', `Select save slot ${s.name}`);
        const nm = document.createElement('span');
        nm.className = 'slot-name';
        nm.textContent = s.name;
        const meta = document.createElement('span');
        meta.className = 'slot-meta';
        const baseMeta = s.runs > 0
          ? `◆${s.merit} · ${s.runs} run${s.runs === 1 ? '' : 's'} · ${s.playtimeMin}m`
          : 'empty';
        // hardcore-ironman: the slot's fate is visible in the picker row.
        meta.textContent = baseMeta + (s.dead ? ' · DEAD' : s.ironman ? ' · IRONMAN' : '');
        pick.append(nm, meta);
        pick.addEventListener('click', (e) => { e.stopPropagation(); opts.onSelectSlot?.(s.id); });
        row.appendChild(pick);

        const ren = document.createElement('button');
        ren.className = 'slot-btn slot-rename';
        ren.setAttribute('aria-label', `Rename save slot ${s.name}`);
        ren.textContent = '✎';
        ren.addEventListener('click', (e) => { e.stopPropagation(); startRename(row, s, nm, ren); });
        row.appendChild(ren);

        const del = document.createElement('button');
        del.className = 'slot-btn slot-del';
        del.setAttribute('aria-label', `Delete save slot ${s.name}`);
        del.textContent = '🗑';
        let disarm: ReturnType<typeof setTimeout> | undefined;
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!del.classList.contains('armed')) {
            del.classList.add('armed');
            del.textContent = '⁉';
            clearTimeout(disarm);
            // 10s confirm window: generous on slow devices (and under
            // automation, where a single click's actionability checks can
            // take ~1s); a second tap inside the window confirms.
            disarm = setTimeout(() => { del.classList.remove('armed'); del.textContent = '🗑'; }, 10_000);
            return;
          }
          clearTimeout(disarm);
          opts.onDeleteSlot?.(s.id);
        });
        // the last slot can never be deleted — the delete button is inert
        if (opts.slots.length <= 1) del.disabled = true;
        row.appendChild(del);
        sw.appendChild(row);
      }
      if (opts.canNewSlot) {
        const nw = document.createElement('button');
        nw.className = 'slot-new';
        nw.textContent = '＋ NEW SLOT';
        nw.addEventListener('click', (e) => { e.stopPropagation(); opts.onNewSlot?.(); });
        sw.appendChild(nw);
      }
      ov.appendChild(sw);
    }

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
        let denyTimer: ReturnType<typeof setTimeout> | undefined;
        d.addEventListener('click', (e) => {
          e.stopPropagation();
          if (m.equipped || m.owned) { opts.onToggleModifier?.(m.id); return; }
          if ((opts.merit ?? 0) < m.cost) {
            // N10: insufficient merit — visible feedback instead of a silent
            // no-op. purchaseModifier would reject this too, so don't call
            // through (avoids a pointless title re-render). Toast can't be
            // used here: hud.update doesn't run on the title screen, so a
            // toast would freeze on screen — shake + label flash instead.
            d.classList.remove('denied');
            void d.offsetWidth; // restart the CSS shake on repeat clicks
            d.classList.add('denied');
            ac.textContent = `NEED ◆${m.cost - (opts.merit ?? 0)} MORE`;
            clearTimeout(denyTimer);
            denyTimer = setTimeout(() => {
              d.classList.remove('denied');
              ac.textContent = `BUY ◆${m.cost}`;
            }, 900);
            return;
          }
          opts.onBuyModifier?.(m.id);
        });
        mods.appendChild(d);
      }
      ov.appendChild(mods);
    }

    // UPGRADE LOOP (hardcore-ironman): mode picker with an explicit
    // confirm step, and the dead-slot notice. Every control
    // stopPropagation()s like the slot picker: touching the picker is
    // not starting a run. On an already-ironman slot the IRONMAN button
    // just starts (no second confirm — the slot is already ironman).
    // On a dead slot there is no picker at all: the notice replaces it,
    // the start button is disabled below, and the overlay click-to-start
    // is not bound — a dead slot has no start path.
    if (opts.slotDead) {
      const dead = document.createElement('div');
      dead.className = 'slot-dead-notice';
      dead.id = 'xandria-slot-dead-notice';
      dead.textContent = 'THIS SLOT IS DEAD — death ended its ironman run permanently. Switch slots or create a new one.';
      ov.appendChild(dead);
    } else if (opts.onStartIronman) {
      const mp = document.createElement('div');
      mp.className = 'mode-picker';
      const label = document.createElement('span');
      label.className = 'mode-label';
      label.textContent = opts.ironmanActive ? 'MODE: IRONMAN' : 'MODE: NORMAL';
      const confirm = document.createElement('div');
      confirm.className = 'ironman-confirm';
      confirm.id = 'xandria-ironman-confirm';
      confirm.style.display = 'none';
      const ct = document.createElement('div');
      ct.className = 'ironman-confirm-text';
      ct.textContent = 'IRONMAN: one life. Death ends this slot permanently — no respawn, no revive. Survive and your score is multiplied.';
      const ok = document.createElement('button');
      ok.className = 'ironman-confirm-ok';
      ok.textContent = 'CONFIRM IRONMAN';
      ok.addEventListener('click', (e) => { e.stopPropagation(); opts.onStartIronman!(); });
      const cancel = document.createElement('button');
      cancel.className = 'ironman-confirm-cancel';
      cancel.textContent = 'CANCEL';
      cancel.addEventListener('click', (e) => { e.stopPropagation(); confirm.style.display = 'none'; });
      confirm.append(ct, ok, cancel);
      const ib = document.createElement('button');
      ib.className = 'mode-ironman-btn';
      ib.id = 'xandria-ironman-btn';
      ib.textContent = opts.ironmanActive ? 'IRONMAN ✓' : 'IRONMAN';
      ib.setAttribute('aria-label', 'Start an ironman run');
      ib.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opts.ironmanActive) { opts.onStart(); return; }
        confirm.style.display = confirm.style.display === 'none' ? '' : 'none';
      });
      mp.append(label, ib, confirm);
      ov.appendChild(mp);
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
    // hardcore-ironman: a dead slot's start button is inert (the overlay
    // click is also unbound below — defense in depth, engine guards too).
    if (opts.slotDead) b.disabled = true;
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
      db.className = 'daily-btn' + (opts.dailyPlayed ? ' played' : '');
      db.textContent = opts.dailyLabel;
      if (opts.dailyPlayed) {
        // one attempt per day: the button is locked, clicking does nothing.
        db.disabled = true;
      } else {
        db.addEventListener('click', (e) => {
          e.stopPropagation();
          if (started) return;
          started = true;
          opts.onDaily!();
        });
      }
      row.appendChild(db);
      if (opts.dailyChallengeLine && !opts.dailyPlayed) {
        const line = document.createElement('div');
        line.className = 'daily-challenge-line';
        line.textContent = opts.dailyChallengeLine;
        row.appendChild(line);
      }
      ov.append(b, row);

      // Challenge board: today + the last 7 days, newest first. Local-only —
      // the tuples recompute from each date, results come from the profile.
      if (opts.dailyBoard && opts.dailyBoard.length) {
        const board = document.createElement('div');
        board.className = 'daily-board';
        const head = document.createElement('div');
        head.className = 'daily-board-head';
        head.textContent = 'CHALLENGE BOARD';
        board.appendChild(head);
        for (const r of opts.dailyBoard) {
          const d = document.createElement('div');
          d.className = 'daily-board-row' + (r.today ? ' today' : '');
          const dt = document.createElement('span');
          dt.className = 'dbr-date';
          dt.textContent = r.today ? 'TODAY' : r.date.slice(5);
          const gl = document.createElement('span');
          gl.className = 'dbr-goal';
          gl.textContent = `${r.goalText} · ${r.loadoutText}`;
          const rs = document.createElement('span');
          rs.className = 'dbr-result';
          rs.textContent = r.result
            ? `${r.result.won ? 'WON' : 'LOST'} ${r.result.score.toLocaleString('en-US')} · K${r.result.kills}`
            : '—';
          d.append(dt, gl, rs);
          board.appendChild(d);
        }
        ov.appendChild(board);
      }
    } else {
      ov.appendChild(b);
    }


    // Gauntlet mode: entry button + boss-order line + board. Local-only —
    // the tuples recompute from each date, results come from the profile.
    if (opts.onGauntlet && opts.gauntletLabel) {
      const grow = document.createElement('div');
      grow.className = 'gauntlet-row';
      const gb = document.createElement('button');
      gb.className = 'gauntlet-btn';
      gb.textContent = opts.gauntletLabel;
      gb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (started) return;
        started = true;
        opts.onGauntlet!();
      });
      grow.appendChild(gb);
      if (opts.gauntletLine) {
        const gline = document.createElement('div');
        gline.className = 'gauntlet-line';
        gline.textContent = opts.gauntletLine;
        grow.appendChild(gline);
      }
      ov.appendChild(grow);

      if (opts.gauntletBoard && opts.gauntletBoard.length) {
        const board = document.createElement('div');
        board.className = 'gauntlet-board';
        const head = document.createElement('div');
        head.className = 'gauntlet-board-head';
        head.textContent = 'GAUNTLET BOARD';
        board.appendChild(head);
        for (const r of opts.gauntletBoard) {
          const d = document.createElement('div');
          d.className = 'gauntlet-board-row' + (r.today ? ' today' : '');
          const dt = document.createElement('span');
          dt.className = 'gbr-date';
          dt.textContent = r.today ? 'TODAY' : r.date.slice(5);
          const gl = document.createElement('span');
          gl.className = 'gbr-bosses';
          gl.textContent = r.bossesText;
          const rs = document.createElement('span');
          rs.className = 'gbr-result';
          rs.textContent = r.result
            ? `R${r.result.roundsCleared}/5 ${r.result.won ? 'WON' : ''} ${r.result.score.toLocaleString('en-US')}`.trim()
            : '—';
          d.append(dt, gl, rs);
          board.appendChild(d);
        }
        ov.appendChild(board);
      }
    }

    // run-journal wave: the journal entry point lives on the title
    // screen. stopPropagation: the overlay's click-to-start handler must not
    // fire when the player opens the journal.
    if (opts.onJournal) {
      const jr = document.createElement('div');
      jr.className = 'journal-row';
      const jb = document.createElement('button');
      jb.className = 'journal-btn';
      jb.id = 'xandria-journal-open';
      jb.textContent = '\uD83D\uDCCF RUN JOURNAL';
      jb.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onJournal!();
      });
      jr.appendChild(jb);
      ov.appendChild(jr);
    }

    // character-customization: same row pattern as the journal button.
    if (opts.onCustomize) {
      const cr = document.createElement('div');
      cr.className = 'journal-row';
      const cb = document.createElement('button');
      cb.className = 'journal-btn';
      cb.id = 'xandria-customize-open';
      cb.textContent = '✦ CUSTOMIZE';
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onCustomize!();
      });
      cr.appendChild(cb);
      ov.appendChild(cr);
    }

    // hardcore-ironman: no click-to-start on a dead slot (see picker above).
    if (!opts.slotDead) ov.addEventListener('click', go);
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
      mk('CUSTOMIZE', () => eng?.customizationPanel?.show()),
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
    // className (not classList): the unit-test DOM stub exposes className
    // only, and the real DOM accepts the same string form.
    if (!ov.className.includes('settings-view')) ov.className = `${ov.className} settings-view`.trim();
    ov.innerHTML = '';
    const h = document.createElement('h1');
    h.textContent = 'SETTINGS';
    h.style.fontSize = '30px';
    const s = eng?.settings.data ?? { volume: 0.8, muted: false, quality: 'auto' as const, tier: 'auto' as const, floatingText: true, musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8 };
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

    // Graphics wave 2 (E): perf-tier override. Changing it live re-resolves
    // the flags; density budgets apply on the next world build (a rebuild is
    // needed for pool reallocation — same as a quality change needing one).
    const trow = document.createElement('div');
    trow.className = 'settings-row';
    const tlab = document.createElement('span');
    tlab.textContent = 'PERF TIER';
    const tsel = document.createElement('select');
    tsel.setAttribute('aria-label', 'Perf tier');
    for (const t of ['auto', 'desktop', 's25'] as const) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t.toUpperCase();
      if (t === s.tier) o.selected = true;
      tsel.appendChild(o);
    }
    tsel.addEventListener('change', () => {
      eng?.settings.set({ tier: tsel.value as typeof s.tier });
      eng?.applySettings();
    });
    trow.append(tlab, tsel);

    // UPGRADE LOOP (difficulty-modes): difficulty selector. Player-scoped
    // and persisted via the profile (engine.setDifficultyMode). Changes
    // are refused while any enemy is hostile (no changes in combat) — the
    // row is disabled and carries an explanatory note in that case.
    const drow = document.createElement('div');
    drow.className = 'settings-row';
    const dlab = document.createElement('span');
    dlab.textContent = 'DIFFICULTY';
    const dsel = document.createElement('select');
    dsel.setAttribute('aria-label', 'Difficulty');
    const inCombat = typeof eng?.inCombat === 'function' ? eng.inCombat() : false;
    const curDiff = typeof eng?.getDifficultyMode === 'function' ? eng.getDifficultyMode() : 'normal';
    for (const d of ['story', 'normal', 'hard'] as const) {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d.toUpperCase();
      if (d === curDiff) o.selected = true;
      dsel.appendChild(o);
    }
    const dnote = document.createElement('span');
    dnote.className = 'settings-note';
    if (inCombat) {
      dsel.disabled = true;
      dnote.textContent = 'LOCKED IN COMBAT';
    }
    dsel.addEventListener('change', () => {
      const setMode = typeof eng?.setDifficultyMode === 'function' ? eng.setDifficultyMode.bind(eng) : null;
      const res = setMode?.(dsel.value as 'story' | 'normal' | 'hard');
      if (res && !res.ok) {
        // refused (in combat) — revert the picker and say why
        dsel.value = typeof eng?.getDifficultyMode === 'function' ? eng.getDifficultyMode() : 'normal';
        dnote.textContent = (res.reason ?? 'change refused').toUpperCase();
        eng?.audio.play('alarm');
      } else {
        eng?.audio.play('click');
      }
    });
    drow.append(dlab, dsel, dnote);

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

    // DAMAGE-NUMBERS: floating combat-text toggle, persisted per save
    // slot via Settings (survives reload; Engine.applySettings pushes it
    // into Juice, where off clears live numbers immediately).
    const frow = document.createElement('div');
    frow.className = 'settings-row';
    const flab = document.createElement('span');
    flab.textContent = 'DAMAGE NUMBERS';
    const fcb = document.createElement('input');
    fcb.type = 'checkbox';
    fcb.checked = s.floatingText !== false;
    fcb.setAttribute('aria-label', 'Damage numbers');
    fcb.addEventListener('change', () => {
      eng?.settings.set({ floatingText: fcb.checked });
      eng?.applySettings();
    });
    frow.append(flab, fcb);
    // UPGRADE LOOP (audio-system): per-bus toggles + volumes. Persisted
    // per save slot via settings.set; applySettings() pushes them to the
    // audio buses live. Rows reuse .settings-row so touch targets match
    // the existing settings controls (>= 28px, asserted in e2e). The rows
    // join the final append below (after MUTE) so the existing row order
    // — volume, quality, tier, difficulty, mute — is unchanged.
    const mkToggle = (label: string, aria: string, checked: boolean, onChange: (v: boolean) => void) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const lab = document.createElement('span');
      lab.textContent = label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.setAttribute('aria-label', aria);
      cb.addEventListener('change', () => {
        onChange(cb.checked);
        eng?.applySettings();
      });
      row.append(lab, cb);
      return row;
    };
    const mkSlider = (label: string, aria: string, value01: number, onInput: (v: number) => void) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const lab = document.createElement('span');
      lab.textContent = label;
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = '0'; sl.max = '100';
      sl.value = String(Math.round(value01 * 100));
      sl.setAttribute('aria-label', aria);
      sl.addEventListener('input', () => {
        onInput(Number(sl.value) / 100);
        eng?.applySettings();
      });
      row.append(lab, sl);
      return row;
    };
    const musicRow = mkToggle('MUSIC', 'Music', s.musicEnabled !== false, (v) => eng?.settings.set({ musicEnabled: v }));
    const sfxRow = mkToggle('SOUND FX', 'Sound effects', s.sfxEnabled !== false, (v) => eng?.settings.set({ sfxEnabled: v }));
    const musicVolRow = mkSlider('MUSIC VOLUME', 'Music volume', s.musicVolume ?? 0.8, (v) => eng?.settings.set({ musicVolume: v }));
    const sfxVolRow = mkSlider('SFX VOLUME', 'SFX volume', s.sfxVolume ?? 0.8, (v) => eng?.settings.set({ sfxVolume: v }));

    // ACCESSIBILITY PASS: colorblind palette, reduced motion, HUD text
    // scale, keybinds — all persisted in the profile (see Engine.
    // applyAccessibilitySettings) so they survive reload + portal travel.
    const acc = typeof eng?.getAccessibilitySettings === 'function'
      ? eng.getAccessibilitySettings()
      : null;
    const arow = document.createElement('div');
    arow.className = 'settings-row';
    const alab = document.createElement('span');
    alab.textContent = 'COLORBLIND';
    const asel = document.createElement('select');
    asel.setAttribute('aria-label', 'Colorblind palette');
    for (const p of COLORBLIND_PALETTES) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p.toUpperCase();
      if (acc && p === acc.colorblind) o.selected = true;
      asel.appendChild(o);
    }
    asel.addEventListener('change', () => {
      eng?.applyAccessibilitySettings({ colorblind: asel.value as ColorblindPalette });
      eng?.audio.play('click');
    });
    arow.append(alab, asel);

    const rrow = document.createElement('div');
    rrow.className = 'settings-row';
    const rlab = document.createElement('span');
    rlab.textContent = 'REDUCED MOTION';
    const rcb = document.createElement('input');
    rcb.type = 'checkbox';
    rcb.checked = !!acc?.reducedMotion;
    rcb.setAttribute('aria-label', 'Reduced motion');
    rcb.addEventListener('change', () => {
      eng?.applyAccessibilitySettings({ reducedMotion: rcb.checked });
      eng?.audio.play('click');
    });
    rrow.append(rlab, rcb);

    const xrow = document.createElement('div');
    xrow.className = 'settings-row';
    const xlab = document.createElement('span');
    xlab.textContent = 'HUD TEXT SIZE';
    const xsl = document.createElement('input');
    xsl.type = 'range'; xsl.min = '85'; xsl.max = '150';
    xsl.value = String(Math.round((acc?.hudTextScale ?? 1) * 100));
    xsl.setAttribute('aria-label', 'HUD text size');
    xsl.addEventListener('input', () => {
      eng?.applyAccessibilitySettings({ hudTextScale: Number(xsl.value) / 100 });
    });
    xrow.append(xlab, xsl);

    // Keybinds: one row per remappable action. Click a key button, then
    // press the new key — capture-phase listener so the game input layer
    // never sees the capture keystroke. Conflicts are rejected with a
    // note (never silently applied); Escape cancels the capture.
    const kbWrap = document.createElement('div');
    kbWrap.className = 'settings';
    const kbHead = document.createElement('div');
    kbHead.className = 'settings-row';
    const kbHeadLab = document.createElement('span');
    kbHeadLab.textContent = 'KEYBINDS';
    kbWrap.append(kbHead);
    const kbNote = document.createElement('div');
    kbNote.className = 'settings-note';
    kbNote.textContent = '';
    const curBinds: Record<string, string> = eng?.input
      ? (eng.input.getKeybinds() as Record<string, string>)
      : {};
    const refreshKbNote = (msg: string) => { kbNote.textContent = msg; };
    let capturing: { action: RemappableAction; btn: HTMLButtonElement } | null = null;
    const stopCapture = () => {
      if (!capturing) return;
      capturing.btn.textContent = keyDisplayName(curBinds[capturing.action] ?? '');
      capturing = null;
    };
    const onCaptureKey = (e: KeyboardEvent) => {
      if (!capturing) return;
      // Panel torn down without BACK (e.g. pause dismissed): drop the
      // listener instead of swallowing a live game keystroke.
      if (!kbWrap.isConnected) {
        capturing = null;
        if (typeof window !== 'undefined') window.removeEventListener('keydown', onCaptureKey, true);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const { action, btn } = capturing;
      capturing = null;
      if (e.code === 'Escape') {
        btn.textContent = keyDisplayName(curBinds[action] ?? '');
        return;
      }
      const cur: KeybindOverrides = eng?.getAccessibilitySettings
        ? eng.getAccessibilitySettings().keybinds
        : {};
      const res = tryRemap(validateKeybinds(cur), action, e.code);
      if (!res.ok) {
        btn.textContent = keyDisplayName(curBinds[action] ?? '');
        refreshKbNote(`KEY REJECTED: ${res.reason.toUpperCase()}`);
        eng?.audio.play('alarm');
        return;
      }
      const applied = eng?.applyAccessibilitySettings({ keybinds: res.overrides });
      if (applied) {
        curBinds[action] = e.code;
        btn.textContent = keyDisplayName(e.code);
        refreshKbNote('');
        eng?.audio.play('click');
      } else {
        btn.textContent = keyDisplayName(curBinds[action] ?? '');
        refreshKbNote('KEY REJECTED: ENGINE UNAVAILABLE');
      }
    };
    // Headless/unit-test environments have no window — the capture
    // listener is a browser-only concern.
    if (typeof window !== 'undefined') window.addEventListener('keydown', onCaptureKey, true);
    for (const action of UI_REMAPPABLE_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const lab = document.createElement('span');
      lab.textContent = action.toUpperCase();
      const btn = document.createElement('button');
      btn.textContent = keyDisplayName(curBinds[action] ?? '');
      btn.setAttribute('aria-label', `Rebind ${action}`);
      btn.addEventListener('click', () => {
        if (capturing) stopCapture();
        capturing = { action, btn };
        btn.textContent = 'PRESS KEY…';
        refreshKbNote('PRESS A KEY (ESC TO CANCEL)');
      });
      row.append(lab, btn);
      kbWrap.append(row);
    }
    kbWrap.append(kbNote);

    const back = document.createElement('button');
    back.textContent = 'BACK';
    back.addEventListener('click', () => {
      // Leaving settings drops the key-capture listener (see isConnected
      // guard above for the dismiss-without-BACK path).
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onCaptureKey, true);
      eng?.audio.play('click'); this.showPause();
    });
    wrap.append(vrow, qrow, trow, drow, mrow, frow, musicRow, sfxRow, musicVolRow, sfxVolRow, arow, rrow, xrow, kbWrap);
    ov.append(h, wrap, back);
    this.overlay = ov;
  }

  /**
   * UPGRADE LOOP (new-game-plus): the optional 4th argument offers NG+
   * entry on the run-end screen. The button is appended to the same
   * button row (after TITLE) ONLY when an offer is supplied — callers
   * without an offer render exactly the old RESTART/TITLE row, so the
   * existing showEnd button contract is unchanged. Offered on both
   * victory and defeat: NG+ is an opt-in harder cycle, not a reward,
   * and the run-completion path covers both endings.
   */
  showEnd(won: boolean, stats: RunStats, winText?: string, ngPlus?: { targetCycle: number; onEnter: () => void }) {
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
    // Run-journal wave: the run-recap screen — the run's observed stats,
    // shown on the end screen before the player returns to the title.
    const recapBits: string[] = [];
    if (stats.deaths !== undefined) recapBits.push(`DEATHS ${stats.deaths}`);
    if (stats.portals !== undefined) recapBits.push(`PORTALS ${stats.portals}`);
    if (stats.bossesKilled !== undefined) recapBits.push(`BOSSES ${stats.bossesKilled}`);
    if (stats.xpGained !== undefined) recapBits.push(`XP +${Math.round(stats.xpGained)}`);
    if (stats.seed !== undefined) recapBits.push(`SEED ${stats.seed}`);
    // hardcore-ironman: the bonus multiplier rides in the recap, and a
    // dead slot says so plainly. RESTART (and any NG+ offer) are omitted
    // below when the slot died — there is no respawn path to offer.
    if (stats.ironman && stats.ironmanMult !== undefined) {
      const m = stats.ironmanMult;
      recapBits.push(`IRONMAN ×${m.toFixed(m % 1 === 0 ? 1 : 2)}`);
    } else if (stats.ironman) {
      recapBits.push('IRONMAN');
    }
    const btnWrap = document.createElement('div');
    const again = document.createElement('button');
    again.textContent = 'RESTART';
    again.addEventListener('click', () => this.eng?.restart());
    const title = document.createElement('button');
    title.textContent = 'TITLE';
    title.addEventListener('click', () => this.eng?.toTitle());
    if (!stats.ironmanDead) btnWrap.append(again, title);
    else btnWrap.append(title);
    if (ngPlus && !stats.ironmanDead) {
      const ng = document.createElement('button');
      ng.className = 'ngplus-btn';
      ng.setAttribute('data-cycle', String(ngPlus.targetCycle));
      ng.textContent = `NEW GAME+ ${ngPlus.targetCycle}`;
      ng.addEventListener('click', () => ngPlus.onEnter());
      btnWrap.append(ng);
    }
    if (recapBits.length) {
      const recap = document.createElement('div');
      recap.className = 'stats recap';
      recap.id = 'xandria-run-recap';
      // textContent (not innerHTML): all values are numbers from the engine
      recap.textContent = `RUN RECAP — ${recapBits.join(' · ')}`;
      this.overlay.append(h, sub, statsEl, recap, btnWrap);
    } else {
      this.overlay.append(h, sub, statsEl, btnWrap);
    }
    // hardcore-ironman: the dead-slot line sits under the buttons, with
    // its own id so e2e can assert it exactly.
    if (stats.ironmanDead) {
      const dead = document.createElement('div');
      dead.className = 'ironman-dead';
      dead.id = 'xandria-ironman-dead';
      dead.textContent = 'SLOT PERMANENTLY DEAD — NO RESPAWN';
      this.overlay.appendChild(dead);
    }
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
    this.setTier(1);
    this.setObjective(this.spec.objective.description, '');
    this.setProgress('');
    this.setHint('');
    this.setLowHp(false);
    this.vignetteT = 0;
    this.toastT = 0;
    this.vignette.style.opacity = '0';
    this.toastEl.style.opacity = '0';
  }

  /** Remove any overlay (title / pause / settings / end / level-up / story card). Public for Engine. */
  clearOverlays() {
    this.overlay?.remove(); this.overlay = null;
    // N8: story cards are appended straight to root (non-blocking) — a card
    // shown just before a restart must not survive into the new run
    this.card?.remove(); this.card = null;
    // R4-M1: drop queued modals first — a level-up queued in a dying run must
    // never pop over the new run's UI. Then dismiss the live modal (N5).
    this.modalQueue.length = 0;
    // N5: dismiss any live level-up/choice modal — removes the element and
    // its document keydown listener, then settles the promise so no stale
    // modal callback survives teardown/restart
    this.abandonModal();
  }
}
