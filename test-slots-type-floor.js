// Medicus Suite — Slots type floor and side-panel tab strip (v4.0.2)
// Run with: node test-slots-type-floor.js
//
// Locks the readable-type pass: hero count 32px/700 tabular, free caption
// 12px/600 in --green-ink, other Slots labels at least 12px, nav tabs 12px
// mono uppercase, and a visible scrollbar that does not smooth-scroll when
// the user prefers reduced motion.

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  OK  ' + msg);
    passed++;
  } else {
    console.error('  FAIL  ' + msg);
    failed++;
    process.exitCode = 1;
  }
}

const root = __dirname;
const slots = fs.readFileSync(path.join(root, 'side-panel/modules/slots/slots.css'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'side-panel/panel.css'), 'utf8');
const panelJs = fs.readFileSync(path.join(root, 'side-panel/panel.js'), 'utf8');

function blocks(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}

function block(css, selector) {
  return blocks(css, selector)[0] || '';
}

const hero = block(slots, '.slots-count-hero');
check(/font-size:\s*32px/.test(hero), 'hero count is 32px');
check(/font-weight:\s*700/.test(hero), 'hero count is weight 700');
check(/tabular-nums/.test(hero), 'hero count uses tabular figures');
check(/var\(--text-1\)/.test(hero), 'hero count uses --text-1 (#0f172a in light)');
check(!/font-size:\s*40px/.test(slots), 'slots no longer uses a 40px count');

const label = block(slots, '.slots-count-label');
check(/font-size:\s*12px/.test(label), 'free caption is 12px');
check(/font-weight:\s*600/.test(label), 'free caption is weight 600');
check(/var\(--green-ink\)/.test(label), 'free caption uses --green-ink');
check(!/color:\s*var\(--green\)/.test(label), 'free caption does not use the failing light --green');

const heroMain = block(slots, '.slots-hero-main');
check(/gap:\s*8px/.test(heroMain), 'gap between the hero number and the caption is 8px');

check(/--green-ink:\s*#166534/.test(panel), 'light --green-ink is #166534');
const dark = panel.split("html[data-theme='dark']")[1].split('html,')[0];
check(/--green:\s*#4ade80/.test(dark), 'dark --green stays #4ade80');
check(/--green-ink:\s*var\(--green\)/.test(dark), 'dark free caption keeps --green');
const cb = panel.split("html[data-colorblind='true']")[1].split('/* Colorblind badge')[0];
check(/--green-ink:\s*var\(--accent\)/.test(cb), 'colour-blind free caption uses --accent');

const tab = block(panel, '.nav-tab');
check(/font-size:\s*12px/.test(tab), 'nav tabs are 12px');
check(/var\(--mono\)/.test(tab), 'nav tabs stay mono');
check(/uppercase/.test(tab), 'nav tabs stay uppercase');
check(/font-size:\s*10px/.test(tab) === false, 'nav tabs are no longer 10px');

const tabs = blocks(panel, '.nav-tabs').find((b) => /overflow-x/.test(b)) || '';
check(/scrollbar-width:\s*thin/.test(tabs), 'tab strip scrollbar is visible');
check(!/scrollbar-width:\s*none/.test(tabs), 'tab strip does not hide its scrollbar');
check(!/mask-image/.test(tabs), 'tab strip does not fade out a label');

const reduced = panel.split('@media (prefers-reduced-motion: reduce)')[1].slice(0, 600);
check(/\.nav-tabs[\s\S]*scroll-behavior:\s*auto/.test(reduced), 'reduced motion turns off smooth tab scrolling');
check(/prefers-reduced-motion:\s*reduce/.test(panelJs), 'tab arrow clicks honour reduced motion');
check(/navScrollBehavior/.test(panelJs), 'tab arrow clicks use the reduced-motion helper');

// Labels floor at 12px. Fields, numeric counts, separators, and sentence
// body stay as they were — this pass is the caption floor, not every control.
const UNDER = /font-size:\s*(9|10|11)px/g;
const allowedUnder = new Set([
  '.date-input',
  '.staff-count-mini .staff-count',
  '.slot-count-sep',
  '.slots-alert-ribbon',
  '.slots-alert-editor-note',
  '.slots-alert-rule-row .sar-type',
  '.slots-alert-rule-row .sar-threshold',
  '.bk-select',
  '.bk-text-input',
  '.bk-action-btn',
  '.bk-error',
  '.bk-warn',
  '.bk-confirm-row',
  '.bk-success-detail',
]);
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let rule;
const offenders = [];
while ((rule = ruleRe.exec(slots))) {
  if (!/font-size:\s*(9|10|11)px/.test(rule[2])) continue;
  const sel = rule[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!allowedUnder.has(sel)) offenders.push(sel + ' → ' + rule[2].match(UNDER)[0]);
}
check(offenders.length === 0, 'Slots labels are at least 12px' + (offenders.length ? ': ' + offenders.join('; ') : ''));

const labelSels = [
  '.preset-btn',
  '.section-label',
  '.section-hint',
  '.slot-type',
  '.staff-toggle',
  '.staff-type-row',
  '.slots-empty-label',
  '.slots-empty-sub',
  '.foot',
  '.excluded-toggle',
  '.slots-count-label',
  '.slots-taken-line',
  '.slots-hero-asat',
  '.slot-pill-name',
  '.pill-palette-label',
  '.pill-organise-hint',
  '.ampm-tag',
  '.ampm-tag-inline',
  '.slots-ribbon-link',
  '.bk-label',
  '.bk-pt-badge',
  '.bk-confirm-label',
  '.bk-slot-site',
  '.bk-slot-type',
  '.bk-slot-dur',
];
for (const sel of labelSels) {
  const b = block(slots, sel);
  check(/font-size:\s*12px/.test(b), sel + ' is 12px');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
