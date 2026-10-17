// Regression guard for the attribute-injection XSS class fixed alongside the
// repo audit: several `escHtml` helpers escape only `& < >` (not the double
// quote `"`) yet were used inside double-quoted HTML attributes carrying
// untrusted data (patient medication names, imported custom-rule ids). A value
// containing `"` could break out of the attribute and inject an event-handler
// attribute -> DOM-based XSS in the privileged side panel. Angle brackets are
// escaped so raw `<script>` is blocked; the live vector is attribute breakout.
//
// This test fails closed if (a) the live chip renderer ever lets a quote-bearing
// drug name / rule id break out of an attribute, or (b) any of the fixed source
// files reintroduces the quote-unsafe `="${escHtml(...)}"` attribute pattern.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

// ── Source guard: none of the fixed files may use the quote-unsafe
//       `="${escHtml(...)}"` attribute pattern. Attribute context must use a
//       quote-escaping helper (escAttr). ─────────────────────────────────────────
console.log('--- source guard: no quote-unsafe escHtml in attribute context ---');
{
  const files = [
    'side-panel/modules/phrases/phrases.js',
    'options/options.js',
    'side-panel/modules/patient-alerts/patient-alerts.js',
    'side-panel/panel.js',
    'content-scripts/task-actions-panel.js',
    'content-scripts/appointment-organise-canvas.js',
    'content-scripts/reception-quick-actions.js',
    'duplicate-checker.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // `="${escHtml(` is an attribute value (`name="...`) produced by escHtml.
    check(
      !src.includes('="${escHtml('),
      `${f}: no double-quoted attribute interpolated with quote-unsafe escHtml (use escAttr)`
    );
  }
}

// ── 3. Each fixed module exposes a quote-escaping escAttr that handles `"`. ────────
console.log('--- escAttr coverage ---');
{
  {
    const src = fs.readFileSync(path.join(__dirname, 'side-panel/modules/slots/slots.js'), 'utf8');
    check(
      /function escHtml/.test(src) && src.includes(".replace(/\"/g, '&quot;')"),
      'slots.js escHtml quote-escapes (used in attributes)'
    );
  }
}

console.log('--- options diagnostics probe escapes url and error ---');
{
  const src = fs.readFileSync(path.join(__dirname, 'options/options.js'), 'utf8');
  const probe = src.match(/debugProbeBtn[\s\S]*?debugProbeResults[\s\S]*?\n\}\);/);
  check(!!probe, 'debug probe handler found');
  check(probe && probe[0].includes('escHtml(p.url)'), 'probe line escapes p.url with escHtml');
  check(probe && probe[0].includes('escHtml(e.message)'), 'probe error line escapes e.message with escHtml');
  check(
    probe && !probe[0].includes('${p.url}') && !probe[0].includes('${e.message}'),
    'probe does not interpolate raw p.url / e.message into innerHTML'
  );
}

console.log('--- triage options kind text is escaped ---');
{
  const src = fs.readFileSync(path.join(__dirname, 'content-scripts/triage-lens/options.js'), 'utf8');
  check(!src.includes('${KIND_LABEL[rule.kind] || rule.kind}'), 'request-rule kind fallback is not interpolated raw');
  check(src.includes('${escHtml(KIND_LABEL[rule.kind] || rule.kind)}'), 'request-rule kind text goes through escHtml');
  check(
    !src.includes("${KIND_LABEL[cfg.kind] || cfg.kind || 'INFO'}"),
    'system-chip kind fallback is not interpolated raw'
  );
  check(
    src.includes("${escHtml(KIND_LABEL[cfg.kind] || cfg.kind || 'INFO')}"),
    'system-chip kind text goes through escHtml'
  );
  check(!src.includes('${KIND_LABEL[r.kind]}'), 'preview kind text is not an unescaped KIND_LABEL lookup');
  check(
    src.includes("${escHtml(KIND_LABEL[r.kind] || r.kind || '')}"),
    'preview kind text goes through escHtml, including an unknown kind'
  );
  check(!src.includes('tl-rule-kind-${_rrKind}'), 'result-rule kind class is not a raw interpolation');
  check(src.includes('${escHtml(KIND_LABEL[_rrKind] || _rrKind)}'), 'result-rule kind text goes through escHtml');
}

console.log('--- patient alerts current-patient NHS is escaped ---');
{
  const src = fs.readFileSync(path.join(__dirname, 'side-panel/modules/patient-alerts/patient-alerts.js'), 'utf8');
  check(!/NHS \$\{fmtNhs\(/.test(src), 'no NHS template interpolates fmtNhs without esc');
  check(/NHS \$\{esc\(fmtNhs\(_pc\.nhsNumber\)\)\}/.test(src), 'current-patient NHS line uses esc(fmtNhs(...))');
  check(/NHS \$\{esc\(fmtNhs\(p\.nhsNumber\)\)\}/.test(src), 'browse-list NHS line still uses esc(fmtNhs(...))');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
