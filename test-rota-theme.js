#!/usr/bin/env node
// Rota manager follows the side-panel slate. Source lock: tokens match
// panel.css, light status inks pass AA, theme is not forced dark, and an
// uncovered duty says so in words.
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + msg);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// First brace-delimited block whose prelude matches `startRe`.
function blockAfter(css, startRe) {
  const m = startRe.exec(css);
  if (!m) return '';
  const open = css.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

function props(block) {
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

const panel = read('side-panel/panel.css');
const tokens = read('shared/slate-tokens.css');
const app = read('rota/app/app.css');
const html = read('rota/app/app.html');
const dash = read('rota/app/views/dashboard.js');
const manifest = JSON.parse(read('manifest.json'));

const panelLight = props(blockAfter(panel, /:root\s*\{/));
const panelDark = props(blockAfter(panel, /html\[data-theme='dark'\]\s*\{/));
const tokenLight = props(blockAfter(tokens, /:root\s*\{/));
const tokenDark = props(blockAfter(tokens, /html\[data-theme='dark'\]\s*\{/));
const tokenOs = props(blockAfter(tokens, /html:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\)\s*\{/));
const appRoot = blockAfter(app, /:root\s*\{/);
const appLight = props(appRoot);

check(Object.keys(tokenLight).length > 20, 'shared slate tokens declare a light palette');
for (const [key, value] of Object.entries(tokenLight)) {
  check(panelLight[key] === value, `light ${key} matches panel.css (token ${value}, panel ${panelLight[key]})`);
}
for (const [key, value] of Object.entries(tokenDark)) {
  check(panelDark[key] === value, `dark ${key} matches panel.css (token ${value}, panel ${panelDark[key]})`);
}
for (const [key, value] of Object.entries(tokenDark)) {
  check(tokenOs[key] === value, `prefers-color-scheme dark ${key} matches the data-theme dark token`);
}

check(/@import url\('\.\.\/\.\.\/shared\/slate-tokens\.css'\)/.test(app), 'rota app imports the shared slate tokens');
check(appLight['--amber'] === '#9a3412', 'light amber ink is #9a3412');
check(appLight['--green'] === '#166534', 'light green ink passes AA');
check(appLight['--red'] === '#b91c1c', 'light red ink passes AA');
check(/color-scheme:\s*light/.test(appRoot), 'light theme sets color-scheme light');
check(!/color-scheme:\s*dark/.test(appRoot), 'the default theme does not force color-scheme dark');
check(/html\[data-theme='dark'\][\s\S]*?--control-border:\s*#8eabcb/.test(app), 'dark control border is #8eabcb');
check(/--control-border:\s*var\(--text-3\)/.test(app), 'light control border reuses --text-3');
check(/@media \(prefers-color-scheme:\s*dark\)/.test(app), 'system dark theme is honoured when no theme is stored');
check(/animation:\s*rotaFade var\(--med\) var\(--ease\)/.test(app), 'entrance is the 200ms opacity fade');
check(!/animation-delay/.test(app), 'entrance is not staggered');
check(!/0\.4s/.test(app), 'the 400ms entrance is gone');
check(!/#0b1023|#6366f1|#11173a/.test(app), 'dark-glass page colours are gone');
check(!/backdrop-filter|radial-gradient/.test(app), 'glass blur and glow gradients are gone');
check(
  /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none !important/.test(app),
  'reduced motion drops the fade immediately'
);

check(/display-prefs\.js/.test(html), 'rota app applies the suite theme the way the panel does');
check(dash.includes('Uncovered'), 'an empty duty period says Uncovered');
check(dash.includes('card-warn'), 'the uncovered duty card uses the warning wash');
check(dash.includes('· duty'), 'a rostered duty names the session in words');
check(dash.includes('· leave'), 'leave names itself in words');
check(manifest.version === '4.0.3', 'manifest is 4.0.3');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
