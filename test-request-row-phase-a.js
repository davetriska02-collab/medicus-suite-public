// v4.0.1 request-row ink, type floor, Pharmacy First suppression, status bar.
// Run with: node test-request-row-phase-a.js
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
  }
}

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const LIGHT = {
  '--green:': '#166534',
  '--red:': '#b91c1c',
  '--amber:': '#9a3412',
};

console.log('\n--- light status ink mirrors ---');
[
  'side-panel/panel.css',
  'content-scripts/triage-lens/hud.css',
  'content-scripts/task-presence.css',
  'content-scripts/workload-tracker.css',
  'design-system/src/tokens.css',
].forEach((rel) => {
  const css = read(rel);
  Object.keys(LIGHT).forEach((token) => {
    if (rel === 'content-scripts/task-presence.css' && token !== '--amber:') return;
    check(css.includes(token + ' ' + LIGHT[token]), rel + ' sets ' + token + ' ' + LIGHT[token]);
  });
  check(!/data-colorblind[\s\S]{0,180}#ea580c/.test(css), rel + ' colour-blind red is not #ea580c');
});

const tokens = read('design-system/src/tokens.css');
check(/--text-4:\s*#556377/.test(tokens), 'design-system --text-4 matches the panel');
check(/--text-5:\s*#5f6f85/.test(tokens), 'design-system --text-5 matches the panel');
check(
  /html\[data-colorblind='true'\][\s\S]*?--red:\s*#9a3412/.test(tokens),
  'design-system colour-blind red is #9a3412'
);

const hud = read('content-scripts/triage-lens/hud.css');
check(/\.ch-chip \{[\s\S]*?font-size:\s*12px/.test(hud), 'chips are at least 12px');
check(/\.ch-chip \{[\s\S]*?font-weight:\s*600/.test(hud), 'chips are weight 600');
check(/\.ch-queue-chips \.ch-chip-red::before[\s\S]*?content:\s*'▲ '/.test(hud), 'red-flag chip keeps a triangle');
check(/color var\(--fast\) var\(--ease\)/.test(hud), 'chip colour transition is the 120ms token');
check(/opacity var\(--med\) var\(--ease\)/.test(hud), 'chip opacity transition is the 200ms token');
check(
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*0s/.test(hud),
  'chip motion is zero under reduced motion'
);

const presence = read('content-scripts/task-presence.css');
check(
  /\.ms-tp-chips \.ms-tp-token \{[\s\S]*?background:\s*var\(--amber-dim\)/.test(presence),
  'row token wash is amber'
);
check(
  /\.ms-tp-chips \.ms-tp-token \{[\s\S]*?border-radius:\s*var\(--r-pill\)/.test(presence),
  'row token radius is the pill'
);
check(/\.ms-tp-chips \.ms-tp-token \{[\s\S]*?width:\s*max-content/.test(presence), 'row token sizes to its label');
check(
  /\.ms-tp-chips \.ms-tp-token \{[\s\S]*?container-type:\s*normal/.test(presence),
  'row token is not size-contained'
);
check(/\.ms-tp-chips \.ms-tp-token-icon \{[\s\S]*?font-size:\s*12px/.test(presence), 'initials are 12px');
check(/\.ms-tp-chips \.ms-tp-token-who \{[\s\S]*?font-weight:\s*600/.test(presence), 'presence label is weight 600');

console.log('\n--- Pharmacy First and the status bar ---');
const content = read('content-scripts/triage-lens/content.js');
check(
  /hasRedKeywordChip = ruleMatches\.some\(\(r\) => r && r\.kind === 'red'\)/.test(content),
  'a red keyword match is detected'
);
check(
  /pfElig\.eligible === true && !hasRedKeywordChip/.test(content),
  'Pharmacy First is skipped when that match is present'
);
const render = content.match(/const renderQueueStatusBar = \(\) => \{[\s\S]*?\n {2}\};/);
check(!!render, 'renderQueueStatusBar is still a function');
check(render && !/checking /.test(render[0]), 'renderQueueStatusBar does not build a checking count');
check(render && /removeQueueStatusBar\(\)/.test(render[0]), 'renderQueueStatusBar removes the bar');
const ensure = content.match(/const ensureQueueStatusBarEl = \(\) => \{[\s\S]*?\n {2}\};/);
check(ensure && !/createElement/.test(ensure[0]), 'ensureQueueStatusBarEl does not create the bar');

const options = read('options/options.html');
check(/no red, amber or clear count/.test(options), 'Options does not promise red/amber/clear counts');
check(!/Queue status bar: red\/amber\/clear counts/.test(options), 'the old Options promise is gone');

console.log('\n--- unsigned hazard addenda ---');
const hazard = read('docs/HAZARD-LOG.md');
const h026 = hazard.split('### H-026 —')[1].split('### H-027 —')[0];
const h100 = hazard.split('### H-100 —')[1].split('## 6. Hazard summary')[0];
check(/UNSIGNED/.test(h026) && /Pharmacy First/.test(h026), 'H-026 has an unsigned Pharmacy First addendum');
check(/#b91c1c/.test(h026), 'H-026 records the chip ink change');
check(/Signature: ________________________________/.test(h026), 'H-026 signature line is blank');
check(/UNSIGNED/.test(h100) && /status bar/.test(h100), 'H-100 has an unsigned status-bar addendum');
check(/Signature: ________________________________/.test(h100), 'H-100 signature line is blank');
check(!/Signed: Dr D\. Triska, CSO, GMC 6159481, 1 Nov 2026/.test(h026), 'H-026 addendum is not pre-signed');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
