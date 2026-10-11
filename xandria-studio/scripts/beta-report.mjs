#!/usr/bin/env node
/**
 * beta-report.mjs — human-readable report generator for the XANDRIA beta-test wave.
 *
 * Reads per-suite JSON summaries from tests/e2e/beta/results/*.json
 *   shape: { suite, name, genre?, passed, durationMs, metrics:{...}, errors:[], notes }
 * and optionally a Playwright JSON report (--playwright-json, from
 *   `playwright test --reporter=json`).
 *
 * Writes qa/beta/BETA-REPORT-<YYYY-MM-DD>.md at the REPO ROOT (qa/ lives next
 * to xandria-studio/, NOT inside it).
 *
 * Missing results file for an expected suite => "not run", never a crash.
 *
 * Usage:
 *   node scripts/beta-report.mjs [--results <dir>] [--out <file>]
 *                                 [--playwright-json <file>] [--date <YYYY-MM-DD>]
 *
 * Defaults (relative to the xandria-studio/ dir this script lives in):
 *   --results tests/e2e/beta/results
 *   --out     ../qa/beta/BETA-REPORT-<today>.md
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, '..');          // xandria-studio/
const REPO = resolve(STUDIO, '..');          // repo root

const EXPECTED_SUITES = ['bots', 'fuzz', 'perf', 'soak'];

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const today = new Date().toISOString().slice(0, 10);
const date = arg('--date', today);
const resultsDir = resolve(process.cwd(), arg('--results', join(STUDIO, 'tests/e2e/beta/results')));
const outFile = resolve(process.cwd(), arg('--out', join(REPO, 'qa', 'beta', `BETA-REPORT-${date}.md`)));
const pwJsonPath = arg('--playwright-json', null);

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return 'unknown'; }
}
const branch = git('rev-parse --abbrev-ref HEAD');
const sha = git('rev-parse --short HEAD');

// ---- load results ----
function loadResults(dir) {
  if (!existsSync(dir)) return { rows: [], missing: true };
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const arr = Array.isArray(raw) ? raw : [raw];
      for (const r of arr) rows.push({ ...r, _file: f });
    } catch (e) {
      rows.push({ suite: 'unknown', name: f, passed: false, durationMs: 0, metrics: {}, errors: [`unparseable results file: ${e.message}`], notes: '', _file: f });
    }
  }
  return { rows, missing: false };
}

// ---- optional playwright --reporter=json run ----
function loadPwJson(path) {
  if (!path || !existsSync(resolve(process.cwd(), path))) return null;
  try {
    const j = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
    const byFile = {};
    const walk = (suites) => {
      for (const s of suites || []) {
        for (const sp of s.specs || []) {
          for (const t of sp.tests || []) {
            const last = (t.results || []).slice(-1)[0];
            const entry = { title: sp.title, outcome: last?.status ?? 'unknown', durationMs: last?.duration ?? 0, file: s.file || s.title };
            (byFile[entry.file] ||= []).push(entry);
          }
        }
        walk(s.suites);
      }
    };
    walk(j.suites);
    return { stats: j.stats, byFile };
  } catch { return null; }
}

// ---- helpers ----
const bySuite = (rows, suite) => rows.filter((r) => String(r.suite || '').toLowerCase() === suite);
const ms = (v) => (typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '—');
const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
const bool = (v) => (v === true ? '✅' : v === false ? '❌' : '—');
const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

function metricsCell(r) {
  const m = r.metrics || {};
  return Object.entries(m).map(([k, v]) =>
    `${k}=${typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(3) : Math.round(v * 100) / 100) : esc(v)}`).join(' ');
}

function errorList(rows) {
  const errs = rows.flatMap((r) => (r.errors || []).map((e) => `**${esc(r.name)}**: ${esc(e)}`));
  if (!errs.length) return 'None.';
  return errs.map((e) => `- ${e}`).join('\n');
}

// ---- baselines (optional; perf only) ----
function loadBaseline(suite) {
  const p = join(REPO, 'qa', 'beta', 'baselines', `${suite}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function delta(actual, base) {
  if (typeof actual !== 'number' || typeof base !== 'number' || base === 0) return '—';
  const d = ((actual - base) / base) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

// ---- section builders ----
function botsSection(rows) {
  const lines = ['## bots — genre playability', ''];
  if (!rows.length) return lines.join('\n') + notRun('bots') + '\n';
  lines.push('| genre | scenario | result | progress | nan issues | duration | errors |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const m = r.metrics || {};
    lines.push(`| ${esc(r.genre || '—')} | ${esc(r.name)} | ${bool(r.passed)} | ${pct(m.progress)} | ${m.nanCount ?? (m.nanIssues?.length ?? '—')} | ${ms(r.durationMs)} | ${(r.errors || []).length} |`);
  }
  lines.push('', '### metrics', '');
  for (const r of rows) lines.push(`- **${esc(r.genre || r.name)}**: ${esc(metricsCell(r)) || '—'}`);
  lines.push('', '### errors', '', errorList(rows), '');
  if (rows.some((r) => r.notes)) { lines.push('### notes', ''); for (const r of rows) if (r.notes) lines.push(`- **${esc(r.name)}**: ${esc(r.notes)}`); lines.push(''); }
  return lines.join('\n');
}

function fuzzSection(rows) {
  const lines = ['## fuzz — malformed intents + monkey input', ''];
  if (!rows.length) return lines.join('\n') + notRun('fuzz') + '\n';
  const intentRows = rows.filter((r) => String(r.name).match(/intent|malformed|prompt/i) || r.metrics?.intentFuzzed !== undefined);
  const monkeyRows = rows.filter((r) => !intentRows.includes(r));
  if (intentRows.length) {
    lines.push('### intent fuzz', '');
    lines.push('| intent | result | crash / rejection | duration |');
    lines.push('|---|---|---|---|');
    for (const r of intentRows) {
      const m = r.metrics || {};
      const crashStr = m.crash === true ? 'CRASH' : (m.rejection ? `no crash (${esc(m.rejection)})` : 'no crash');
      lines.push(`| ${esc(String(m.intent ?? r.name).slice(0, 60))} | ${bool(r.passed)} | ${crashStr} | ${ms(r.durationMs)} |`);
    }
    lines.push('');
  }
  if (monkeyRows.length) {
    lines.push('### monkey input', '');
    lines.push('| scenario | result | inputs | nan issues | duration | errors |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of monkeyRows) {
      const m = r.metrics || {};
      lines.push(`| ${esc(r.name)} | ${bool(r.passed)} | ${m.inputsSent ?? m.inputs ?? '—'} | ${m.nanCount ?? (m.nanIssues?.length ?? '—')} | ${ms(r.durationMs)} | ${(r.errors || []).length} |`);
    }
    lines.push('');
  }
  lines.push('### errors', '', errorList(rows), '');
  return lines.join('\n');
}

function perfSection(rows) {
  const lines = ['## perf — frame-time / load / memory', ''];
  if (!rows.length) return lines.join('\n') + notRun('perf') + '\n';
  const base = loadBaseline('perf');
  lines.push('| scenario | result | median fps | p95 frame ms (Δ baseline) | heap MB | load ms | duration |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const m = r.metrics || {};
    const b = base?.[r.name] || base?.[r.genre] || {};
    lines.push(`| ${esc(r.genre || r.name)} | ${bool(r.passed)} | ${m.medianFps ?? m.fps ?? '—'} | ${m.p95FrameMs ?? '—'} (${delta(m.p95FrameMs, b.p95FrameMs)}) | ${m.heapMB ?? '—'} | ${m.loadMs ?? '—'} | ${ms(r.durationMs)} |`);
  }
  lines.push('', base ? '_Baselines from `qa/beta/baselines/perf.json`._' : '_No baselines yet (`qa/beta/baselines/perf.json`) — deltas unavailable._', '');
  lines.push('### errors', '', errorList(rows), '');
  return lines.join('\n');
}

function soakSection(rows) {
  const lines = ['## soak — long-run stability / heap', ''];
  if (!rows.length) return lines.join('\n') + notRun('soak') + '\n';
  lines.push('| scenario | result | duration | heap start MB | heap end MB | heap Δ MB | gc pauses | restarts/crashes |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const m = r.metrics || {};
    lines.push(`| ${esc(r.name)} | ${bool(r.passed)} | ${ms(r.durationMs)} | ${m.heapStartMB ?? '—'} | ${m.heapEndMB ?? '—'} | ${m.heapDeltaMB ?? '—'} | ${m.gcPauses ?? '—'} | ${m.crashes ?? 0} |`);
  }
  lines.push('', '### errors', '', errorList(rows), '');
  return lines.join('\n');
}

function genericSection(suite, rows) {
  const lines = [`## ${suite}`, ''];
  lines.push('| name | result | duration | metrics | errors |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${esc(r.name)} | ${bool(r.passed)} | ${ms(r.durationMs)} | ${esc(metricsCell(r)) || '—'} | ${(r.errors || []).length} |`);
  lines.push('', '### errors', '', errorList(rows), '');
  return lines.join('\n');
}

function notRun(suite) {
  return `> **Status: NOT RUN.** No results file for this suite in the results dir. It was not executed (or the spec failed before writing its summary). Nothing here is evidence of a pass or a fail.\n`;
}

// ---- playwright run section ----
function pwSection(pw) {
  if (!pw) return '';
  const s = pw.stats || {};
  const lines = ['## playwright run', '', `- started: ${s.startTime || '—'}`, `- expected: ${s.expected ?? '—'}, failed: ${s.unexpected ?? '—'}, skipped: ${s.skipped ?? '—'}, flaky: ${s.flaky ?? '—'}`, `- duration: ${s.duration != null ? (s.duration / 1000).toFixed(1) + 's' : '—'}`, ''];
  for (const [file, tests] of Object.entries(pw.byFile)) {
    const fails = tests.filter((t) => t.outcome !== 'passed' && t.outcome !== 'skipped');
    lines.push(`### ${esc(file)}`, '');
    lines.push('| test | outcome | duration |');
    lines.push('|---|---|---|');
    for (const t of tests) lines.push(`| ${esc(t.title)} | ${t.outcome === 'passed' ? '✅' : t.outcome === 'skipped' ? '⏭️' : '❌'} | ${ms(t.durationMs)} |`);
    lines.push('');
    if (!fails.length) lines.push('_All tests in this file passed or were skipped._', '');
  }
  return lines.join('\n');
}

// ---- honest limits ----
function honestLimits(missing) {
  const lines = ['## honest limits', ''];
  lines.push('These beta bots are scripted agents, not players. Everything below is outside what this harness can verify:');
  lines.push('');
  lines.push('- **Real human judgment.** Bots follow intents and press keys; they do not judge whether a game is good, clear, fair, or worth playing.');
  lines.push('- **Art quality.** No bot verdict on visuals, music, or style — only whether the renderer ran without errors.');
  lines.push('- **Fun.** "Progress > 0" means the objective counter moved. It says nothing about whether the game is enjoyable.');
  lines.push('- **Tutorial clarity / onboarding.** Bots boot straight into gameplay; they cannot tell you if a new player understands what to do.');
  lines.push('- **Rare-environment failures.** Results reflect the machines this ran on (swiftshader/headless CI or one dev box). GPU, mobile, and browser-specific quirks are unverified.');
  lines.push('- **Balance and difficulty curves.** A bot finishing a genre says the loop works, not that the difficulty feels right for humans.');
  lines.push('');
  if (missing.length) {
    lines.push('### suites not run (no data)', '');
    for (const s of missing) lines.push(`- **${s}** — not executed; treat any claims about it as unverified.`);
    lines.push('');
  } else {
    lines.push('_All expected suites produced results._', '');
  }
  return lines.join('\n');
}

// ---- verdict ----
function verdict(rows, missing) {
  const failed = rows.filter((r) => r.passed === false);
  const passed = rows.filter((r) => r.passed === true);
  const ran = EXPECTED_SUITES.filter((s) => !missing.includes(s));
  let v, reason;
  if (missing.length === EXPECTED_SUITES.length && !rows.length) { v = '❌ NOT RUN'; reason = 'no suites executed'; }
  else if (failed.length || missing.length) { v = '⚠️ PARTIAL'; reason = `${failed.length} scenario(s) failed, ${missing.length} suite(s) not run`; }
  else { v = '✅ PASS'; reason = `all ${ran.length} suites green`; }
  return `> **VERDICT: ${v}** — ${reason}. ${passed.length} scenario(s) passed, ${failed.length} failed, ${missing.length} suite(s) not run.\n`;
}

// ---- main ----
function main() {
  const { rows, missing: dirMissing } = loadResults(resultsDir);
  const pw = loadPwJson(pwJsonPath);
  const missing = EXPECTED_SUITES.filter((s) => !bySuite(rows, s).length);
  const knownSuites = new Set([...EXPECTED_SUITES]);
  const extraSuites = [...new Set(rows.map((r) => String(r.suite || 'unknown').toLowerCase()))].filter((s) => !knownSuites.has(s) && s !== 'unknown');

  const L = [];
  L.push(`# XANDRIA beta report — ${date}`, '');
  L.push(`- branch: \`${esc(branch)}\` · commit: \`${esc(sha)}\``);
  L.push(`- results dir: \`${esc(resultsDir)}\`${dirMissing ? ' (MISSING — nothing was run or the dir was never created)' : ''}`);
  L.push(`- generated: ${new Date().toISOString()}`);
  L.push('');
  L.push(verdict(rows, missing), '');
  L.push(botsSection(bySuite(rows, 'bots')), '');
  L.push(fuzzSection(bySuite(rows, 'fuzz')), '');
  L.push(perfSection(bySuite(rows, 'perf')), '');
  L.push(soakSection(bySuite(rows, 'soak')), '');
  for (const s of extraSuites) { L.push(genericSection(s, bySuite(rows, s)), ''); }
  if (pw) { L.push(pwSection(pw), ''); }
  L.push(honestLimits(missing), '');
  L.push('---', `_Generated by \`xandria-studio/scripts/beta-report.mjs\`. Contract: \`tests/e2e/beta/lib.ts\`. Missing-file = "not run", never a crash._`);

  const md = L.join('\n');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, md);
  const failed = rows.filter((r) => r.passed === false).length;
  console.log(`wrote ${outFile}`);
  console.log(`suites run: ${EXPECTED_SUITES.filter((s) => !missing.includes(s)).join(', ') || 'none'}; not run: ${missing.join(', ') || 'none'}; rows: ${rows.length}; failed rows: ${failed}`);
}

main();
