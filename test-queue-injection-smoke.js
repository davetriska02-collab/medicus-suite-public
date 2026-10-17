// Medicus Suite — Live-grid injection smoke harness (Phase 0 item 0.1,
// docs/plans/TRIAGE-LENS-2026-07-02.md)
// Run with: node test-queue-injection-smoke.js
//
// The chip-injection layer (content-scripts/triage-lens/content.js) is the
// most-regressed surface in the suite (v3.67 append regression, v3.69 row-id
// no-op) and until now was guarded only by source-greps (Layer 3 of
// test-result-triage-queue.js) and static HTML fixtures
// (fixtures/medicus/queue-*.html) — nothing actually DROVE the injector
// against a fake grid and watched what landed in the DOM. This file does
// that: it vm-extracts the real injection functions from content.js (same
// pattern as test-result-triage-queue.js/test-monitoring-chip.js extracting
// selectResultChips/selectMonitoringDue) and runs them against a small,
// purpose-built fake AG-Grid DOM (same "fake DOM, no jsdom" approach as
// test-lab-file-macro.js — this repo's only runtime devDeps are eslint /
// prettier, see package.json).
//
// EXTRACTED VERBATIM from content.js (the actual injection mechanics under
// test): findQueuePreviewRow, queueChipHost, decorateOneRow,
// decorateQueueRows, queueScope, injectResultChip, reinjectCachedResultChips,
// injectQueueMonitoringChip, reinjectCachedMonitoringChips, plus their small
// pure dependencies (renderChipHtml/escapeHtml, selectResultChips,
// renderSystemChipHtmlMemo, TH/TH_DEFAULTS, parseDate/daysAgo/MONTHS/NOW,
// QUEUE_DECORATED_KEY). Item 1.3 added clearQueueRowTint/reapplyQueueRowTint.
// Item 1.2 (TRIAGE-LENS-2026-07-02.md) added the queue triage status bar:
// computeQueueTriageCounts, nextAlertRowIndex, getQueueTintedRowIndexes,
// ensureQueueStatusBarEl, removeQueueStatusBar, applyQueueFocusClass,
// renderQueueStatusBar, updateQueueStatusBar, onQueueStatusJumpClick,
// onQueueStatusFocusClick, plus their small consts/module state
// (QUEUE_STATUS_BAR_ID, QUEUE_STATUS_FLASH_CLASS, QUEUE_FOCUS_CLASS,
// QUEUE_STATUS_TOOLTIP, the _queueStatus*/_queueFocusAlertsOn/
// _queueStatusBarRafPending module `let`s). Item 4.4 (TRIAGE-LENS-2026-07-02.md)
// added the "all-normal, fileable" queue marker — no new extracted functions
// (it's an additive branch inside the existing injectResultChip/
// reinjectCachedResultChips), just the FILEABLE_CHIP_HTML constant, which rides
// along with injectResultChip's own extraction regex (it's declared just above
// it in content.js).
//
// STUBBED (deliberately, not injection mechanics — already covered by other
// test files): getSystemChip/matchRules (chip *content*/enable-state is
// exercised via selectResultChips in test-result-triage-queue.js Layer 1 and
// selectMonitoringDue in test-monitoring-chip.js Layer 2), showActionMenu
// (only reachable via a click we never simulate), log (console noise).
// requestAnimationFrame is stubbed to run its callback SYNCHRONOUSLY (real
// content.js falls back to setTimeout(fn,0) when rAF is unavailable — this
// harness instead makes updateQueueStatusBar's rAF-coalescing deterministic
// for assertions rather than exercising the async fallback path itself,
// which is a timing/perf concern out of scope for a DOM-injection harness).
//
// NOT COVERED HERE (documented, not faked):
//   - computeQueueRowResult / computeQueueRowMonitoring / the fetch
//     schedulers (scheduleQueueResultTriage / scheduleQueueMonitoring) —
//     network + engine evaluation, out of scope for a DOM-injection
//     harness; that pipeline's wiring is source-verified in
//     test-result-triage-queue.js Layers 3/3b/3c. The item 1.2 "call
//     updateQueueStatusBar() from inside the worker loop after each cache
//     write" wiring is likewise source-verified there, not re-driven here.
//   - refreshQueueChips itself — it also owns the MutationObserver
//     lifecycle (disconnect/observe/setupQueueObserver/removeQueueStatusBar),
//     which needs a real MutationObserver to exercise meaningfully. Instead
//     this harness replicates its DOM-relevant SEQUENCE directly (wipe chip
//     nodes -> decorateQueueRows -> reinjectCachedResultChips ->
//     reinjectCachedMonitoringChips, the same three calls refreshQueueChips
//     makes) so the actual regression surface — "does re-inject restore the
//     right chip on the right row after Vue wipes the DOM" — is exercised
//     behaviourally, while the observer-rearming plumbing stays covered by
//     the existing source-grep in test-result-triage-queue.js Layer 3. The
//     same applies to runQueue's status-bar reset/re-assert calls
//     (_queueStatusJumpPos=null, applyQueueFocusClass()) and
//     teardownQueueObserver's removeQueueStatusBar()/focus-class cleanup —
//     source-verified, not re-driven behaviourally here.
//   - getSystemChip/matchRules' real CONFIG-driven behaviour (custom
//     labels, disabled chips) — stubbed here on purpose; see above.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0,
  failed = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  OK  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

// ============================================================
// Fake DOM + CSS-selector engine
// ============================================================
// Purpose-built for the exact selector shapes the extracted functions use:
// tag, .class (repeatable/AND), [attr], [attr="value"], :not(<simple>), and
// comma-separated groups (OR). Nothing more general is needed.

class El {
  constructor(tag, attrs) {
    this.tag = String(tag || 'div').toLowerCase();
    this.attrs = {};
    this.classes = [];
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this._text = '';
    this._innerHTML = null;
    this._listeners = {};
    // showRuleMatchMenu (items 2.1/2.3/2.5) and the result-chip detail popover
    // (item 2.2) position their popovers via el.style.{position,top,left,zIndex},
    // and item 2.2 measures its anchor via getBoundingClientRect — a plain
    // mutable object + a zero-rect are all the harness needs (position maths is
    // not under test here).
    this.style = {};
    if (attrs) for (const k of Object.keys(attrs)) this.setAttribute(k, attrs[k]);
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  contains(node) {
    if (node === this) return true;
    let p = node && node.parent;
    while (p) {
      if (p === this) return true;
      p = p.parent;
    }
    return false;
  }
  setAttribute(name, value) {
    if (name === 'class') this.classes = String(value).split(/\s+/).filter(Boolean);
    else this.attrs[name] = String(value);
    // Real DOM reflects data-* attributes into .dataset (kebab-case ->
    // camelCase) bidirectionally. The rule-match chip wiring (items 2.1/
    // 2.3/2.5) sets data-rq-idx via setAttribute (so the [data-rq-idx]
    // attribute-selector querySelectorAll below still finds it) and reads it
    // back via el.dataset.rqIdx — mirror that one-way reflection here so
    // both call sites work against this fake DOM the same way they do on a
    // real page.
    if (name.indexOf('data-') === 0) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(value);
    }
  }
  getAttribute(name) {
    if (name === 'class') return this.classes.join(' ');
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  get classList() {
    const self = this;
    return {
      contains: (c) => self.classes.includes(c),
      // Real DOM classList.add/remove are variadic (content.js's clearQueueRowTint
      // calls classList.remove(ROW_TINT_RED, ROW_TINT_AMBER) with two args) — match
      // that here, not just the single-class shape earlier callers happened to use.
      add: (...cs) => {
        for (const c of cs) if (!self.classes.includes(c)) self.classes.push(c);
      },
      remove: (...cs) => {
        self.classes = self.classes.filter((x) => !cs.includes(x));
      },
      // Real classList.toggle(token, force) — item 1.2's status bar/focus-mode
      // code uses the 2-arg boolean-force form throughout (never the 1-arg
      // flip form), so that's the only shape implemented here.
      toggle: (c, force) => {
        const has = self.classes.includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) self.classes.push(c);
        else if (!want && has) self.classes = self.classes.filter((x) => x !== c);
        return want;
      },
    };
  }
  set className(v) {
    this.classes = String(v).split(/\s+/).filter(Boolean);
  }
  get className() {
    return this.classes.join(' ');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) {
    this._innerHTML = v;
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML == null ? '' : this._innerHTML;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    newNode.parent = this;
    if (refNode == null) {
      this.children.push(newNode);
      return newNode;
    }
    const idx = this.children.indexOf(refNode);
    if (idx === -1) {
      this.children.push(newNode);
      return newNode;
    }
    this.children.splice(idx, 0, newNode);
    return newNode;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    child.parent = null;
    return child;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  get firstChild() {
    return this.children.length ? this.children[0] : null;
  }
  get firstElementChild() {
    return this.firstChild;
  }
  get nextElementSibling() {
    if (!this.parent) return null;
    const idx = this.parent.children.indexOf(this);
    return idx >= 0 && idx + 1 < this.parent.children.length ? this.parent.children[idx + 1] : null;
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener() {}
  dispatchEvent() {}
  // Real element.click() dispatches a click event to registered listeners —
  // used below to simulate a GP clicking a rule-match/menu chip without
  // needing a real click-event pipeline.
  click() {
    (this._listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  }
  // (getBoundingClientRect for both menu/popover anchor positioning is defined
  // once near the top of the class — items 2.1/2.3/2.5 and 2.2 share it.)
  querySelector(sel) {
    return findFirst(this, sel);
  }
  querySelectorAll(sel) {
    return findAll(this, sel);
  }
}

function elText(tag, attrs, text) {
  const e = new El(tag, attrs);
  e.textContent = text;
  return e;
}

function collectDescendants(el, out) {
  for (const c of el.children) {
    out.push(c);
    collectDescendants(c, out);
  }
  return out;
}

function matchesCompound(el, token) {
  token = token.trim();
  if (!token) return false;
  let rest = token;
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (el.tag !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const pieceRe = /\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|:not\(([^()]*)\)/g;
  let pm;
  while ((pm = pieceRe.exec(rest))) {
    const piece = pm[0];
    if (piece[0] === '.') {
      if (!el.classes.includes(piece.slice(1))) return false;
    } else if (piece[0] === '[') {
      const am = piece.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      const actual = el.getAttribute(am[1]);
      if (actual === null) return false;
      if (am[2] !== undefined && actual !== am[2]) return false;
    } else if (piece.startsWith(':not(')) {
      if (matchesCompound(el, pm[1])) return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  return selector.split(',').some((tok) => matchesCompound(el, tok));
}

function findFirst(root, sel) {
  const list = collectDescendants(root, []);
  for (const node of list) if (matchesSelector(node, sel)) return node;
  return null;
}
function findAll(root, sel) {
  return collectDescendants(root, []).filter((node) => matchesSelector(node, sel));
}

// `body` mirrors document.body: a stable wrapper the grid root is mounted
// inside of, so status-bar code (item 1.2) that does
// `document.body.appendChild(...)` / `document.getElementById(...)` has
// somewhere real to land, exactly like the live page — the grid root is a
// DESCENDANT of body, not a stand-in for it, so search scope only grows
// (existing per-layer assertions against `rootEl`'s own subtree are
// unaffected: body's subtree is a strict superset).
function makeDocument(rootEl) {
  const body = new El('body');
  if (rootEl) body.appendChild(rootEl);
  return {
    __root: rootEl,
    body,
    createElement(tag) {
      return new El(tag);
    },
    // renderRuleMenuActionItems (items 2.1/2.3/2.5) builds its action-item
    // list in a DocumentFragment before appending it once. A plain container
    // El is a faithful-enough stand-in here: unlike a real fragment it stays
    // as an extra node in the tree rather than being unwrapped on insertion,
    // but querySelector/querySelectorAll (used by every assertion in this
    // harness) recurse through descendants regardless of nesting depth, so
    // that difference is invisible to the tests.
    createDocumentFragment() {
      return new El('#fragment');
    },
    // buildRuleMatchChipEl/buildEvidenceEl (items 2.1/2.3/2.5) build via
    // createTextNode rather than innerHTML (the evidence text is untrusted
    // row-derived content — CLAUDE.md's textContent-only discipline).
    createTextNode(text) {
      const t = new El('#text');
      t.textContent = text;
      return t;
    },
    querySelector(sel) {
      return findFirst(body, sel);
    },
    querySelectorAll(sel) {
      return findAll(body, sel);
    },
    getElementById(id) {
      return collectDescendants(body, []).find((n) => n.id === id) || null;
    },
    contains(node) {
      if (node === rootEl || node === body) return true;
      let p = node && node.parent;
      while (p) {
        if (p === rootEl || p === body) return true;
        p = p.parent;
      }
      return false;
    },
    // closeActionMenu/armActionMenuDismissal (items 2.1/2.3/2.5) and the
    // result-chip detail popover's open/close paths (item 2.2) register/
    // unregister outside-click and Esc listeners on `document` — no-ops here
    // since this harness drives the menu/popover functions directly rather
    // than simulating a real click-outside/keydown event pipeline.
    addEventListener() {},
    removeEventListener() {},
  };
}

// Build a preview/detail row pair matching
// fixtures/medicus/queue-chip-host-current.html (master row-id="<UUID>",
// linked detail row row-id="detail_<UUID>", inner .h-full.w-full > p.q-pa-xs).
function buildPreviewRowPair({ rowIndex, rowId, dob, priority = 'Routine', created = '01 Jan 2020' }) {
  const master = new El('div', { class: 'ag-row', 'row-id': rowId, 'row-index': String(rowIndex) });
  const nameCell = new El('div', { 'col-id': 'patientName', class: 'ag-cell' });
  nameCell.appendChild(elText('span', { class: 'q-name' }, 'Placeholder, Patient'));
  master.appendChild(nameCell);
  master.appendChild(elText('div', { 'col-id': 'dateOfBirth', class: 'ag-cell' }, dob));
  master.appendChild(elText('div', { 'col-id': 'priorityDisplay', class: 'ag-cell' }, priority));
  master.appendChild(elText('div', { 'col-id': 'createdAt', class: 'ag-cell' }, created));

  const detail = new El('div', { class: 'ag-full-width-row', 'row-id': 'detail_' + rowId });
  const wrap = new El('div', { class: 'h-full w-full' });
  wrap.appendChild(elText('p', { class: 'q-pa-xs' }, 'Request: placeholder request text'));
  detail.appendChild(wrap);

  return { master, nameCell, detail, wrap };
}

// Flat single-line row (no preview/detail row at all — CLAUDE.md's
// documented fallback host: [col-id="patientName"]).
function buildFlatRow({ rowIndex, rowId, dob }) {
  const master = new El('div', { class: 'ag-row', 'row-id': rowId, 'row-index': String(rowIndex) });
  const nameCell = new El('div', { 'col-id': 'patientName', class: 'ag-cell' });
  nameCell.appendChild(elText('span', { class: 'q-name' }, 'Doe, Jane'));
  master.appendChild(nameCell);
  master.appendChild(elText('div', { 'col-id': 'dateOfBirth', class: 'ag-cell' }, dob));
  return { master, nameCell };
}

// ============================================================
// vm-extract the real injection functions from content.js
// ============================================================
const src = fs.readFileSync(path.join(__dirname, 'content-scripts', 'triage-lens', 'content.js'), 'utf8');

function extract(re, label) {
  const m = src.match(re);
  check(!!m, `${label} extracted from content.js`);
  return m ? m[0] : '';
}

console.log('Extraction: pulling injection functions + their small pure deps out of content.js');
const parts = [
  extract(/const _HTML_ESC = \{[\s\S]*?\};/, '_HTML_ESC'),
  extract(/const escapeHtml = \(s\)[\s\S]*?;/, 'escapeHtml'),
  extract(/const renderChipHtml = \(chip\) => \{[\s\S]*?\n {2}\};/, 'renderChipHtml'),
  extract(/const MONTHS = \{[\s\S]*?\};/, 'MONTHS'),
  extract(/const NOW = \(\)[\s\S]*?;/, 'NOW'),
  extract(/const parseDate = \(s\) => \{[\s\S]*?\n {2}\};/, 'parseDate'),
  extract(/const daysAgo = \(d\) => \{[\s\S]*?\n {2}\};/, 'daysAgo'),
  extract(/const TH_DEFAULTS = \{[\s\S]*?\};/, 'TH_DEFAULTS'),
  extract(/const TH = \(k\) => \{[\s\S]*?\n {2}\};/, 'TH'),
  extract(/const PREF = \(k, dflt\) => \{[\s\S]*?\n {2}\};/, 'PREF'),
  extract(/const QUEUE_DECORATED_KEY = .*;/, 'QUEUE_DECORATED_KEY'),
  extract(/function selectResultChips\(sev\) \{[\s\S]*?\n {2}\}/, 'selectResultChips'),
  extract(/const renderSystemChipHtmlMemo = \(id, vars\) => \{[\s\S]*?\n {2}\};/, 'renderSystemChipHtmlMemo'),
  extract(/const findQueuePreviewRow = \(row\) => \{[\s\S]*?\n {2}\};/, 'findQueuePreviewRow'),
  extract(/const queueChipHost = \(row, marker\) => \{[\s\S]*?\n {2}\};/, 'queueChipHost'),
  extract(/const decorateOneRow = \(row\) => \{[\s\S]*?\n {2}\};/, 'decorateOneRow'),
  extract(/const decorateQueueRows = \(\) => \{[\s\S]*?\n {2}\};/, 'decorateQueueRows'),
  extract(/const queueScope = \(\)[\s\S]*?;/, 'queueScope'),
  // Item 1.1 leg D (TRIAGE-LENS-2026-07-02.md) — the "couldn't check" grey
  // error chip. RESULT_ERROR_CHIP_HTML is a free variable inside
  // injectResultChip, so it must be extracted alongside it.
  extract(/const RESULT_ERROR_CHIP_HTML =[\s\S]*?;/, 'RESULT_ERROR_CHIP_HTML'),
  // Item 3.1 — the "unit?" meta chip's fixed markup, another free variable
  // injectResultChip reads (same pattern as RESULT_ERROR_CHIP_HTML above).
  extract(/const UNIT_MISMATCH_CHIP_HTML =[\s\S]*?;/, 'UNIT_MISMATCH_CHIP_HTML'),
  // Item 3.2 Part B — the "unclassified" chip builder, another free variable
  // injectResultChip reads (same pattern as UNIT_MISMATCH_CHIP_HTML above). It
  // calls escapeHtml, already extracted above.
  extract(/const buildUnclassifiedChipHtml = \(list\) => \{[\s\S]*?\n {2}\};/, 'buildUnclassifiedChipHtml'),
  // Item 4.4 (TRIAGE-LENS-2026-07-02.md) — the "all-normal, fileable" tick's
  // fixed markup, another free variable injectResultChip reads (same pattern as
  // UNIT_MISMATCH_CHIP_HTML/RESULT_ERROR_CHIP_HTML above).
  extract(/const FILEABLE_CHIP_HTML =[\s\S]*?;/, 'FILEABLE_CHIP_HTML'),
  extract(/const injectResultChip = \(rowIndex, sev, taskUuid, isError\) => \{[\s\S]*?\n {2}\};/, 'injectResultChip'),
  // Item 2.2 — result-chip detail popover: the pure line-builders plus the
  // singleton popover open/close machinery injectResultChip's click handlers call.
  extract(/function buildResultDetail\(report, sevResult\) \{[\s\S]*?\n {2}\}/, 'buildResultDetail'),
  extract(/function formatDetailLine\(entry\) \{[\s\S]*?\n {2}\}/, 'formatDetailLine'),
  // Item 3.1 — the unit-mismatch popover line formatter, a free variable
  // buildResultDetailPopoverEl calls (same pattern as formatDetailLine above).
  extract(/function formatUnitMismatchLine\(m\) \{[\s\S]*?\n {2}\}/, 'formatUnitMismatchLine'),
  extract(
    /let _resultDetailPopoverEl = null;\s*\n\s*let _resultDetailPopoverAnchor = null;/,
    '_resultDetailPopover* module state'
  ),
  extract(/const closeResultDetailPopover = \(\) => \{[\s\S]*?\n {2}\};/, 'closeResultDetailPopover'),
  extract(/const onDocClickForResultPopover = \(e\) => \{[\s\S]*?\n {2}\};/, 'onDocClickForResultPopover'),
  extract(/const onKeydownForResultPopover = \(e\) => \{[\s\S]*?\n {2}\};/, 'onKeydownForResultPopover'),
  // NB: ends at `';` (quote + semicolon) — the text itself contains a bare `;`,
  // so a lazy `[\s\S]*?;` would truncate mid-string and break compilation.
  extract(/const RESULT_ERROR_POPOVER_TEXT =[\s\S]*?';/, 'RESULT_ERROR_POPOVER_TEXT'),
  // Item 2.7 — guidance actions on result rules: buildResultDetailPopoverEl's per-entry
  // actions row, resolved by ruleId against CONFIG.resultRules at render time. Depends
  // on executeAction (extracted below, items 2.1/2.3/2.5 block) for link/snippet clicks.
  extract(/const findResultRuleActionsById = \(ruleId\) => \{[\s\S]*?\n {2}\};/, 'findResultRuleActionsById'),
  extract(/const buildResultRuleActionsRow = \(actions\) => \{[\s\S]*?\n {2}\};/, 'buildResultRuleActionsRow'),
  extract(
    /const buildResultDetailPopoverEl = \(detail, isError, unitMismatches\) => \{[\s\S]*?\n {2}\};/,
    'buildResultDetailPopoverEl'
  ),
  extract(
    /const toggleResultDetailPopover = \(anchorEl, taskUuid, isError\) => \{[\s\S]*?\n {2}\};/,
    'toggleResultDetailPopover'
  ),
  extract(/const reinjectCachedResultChips = \(\) => \{[\s\S]*?\n {2}\};/, 'reinjectCachedResultChips'),
  extract(/const injectQueueMonitoringChip = \(rowIndex, result\) => \{[\s\S]*?\n {2}\};/, 'injectQueueMonitoringChip'),
  extract(/const reinjectCachedMonitoringChips = \(\) => \{[\s\S]*?\n {2}\};/, 'reinjectCachedMonitoringChips'),
  // Item 1.3 — severity row tint (docs/plans/TRIAGE-LENS-2026-07-02.md).
  extract(/const ROW_TINT_RED = .*;/, 'ROW_TINT_RED'),
  extract(/const ROW_TINT_AMBER = .*;/, 'ROW_TINT_AMBER'),
  extract(/const clearQueueRowTint = \(\) => \{[\s\S]*?\n {2}\};/, 'clearQueueRowTint'),
  extract(/const reapplyQueueRowTint = \(\) => \{[\s\S]*?\n {2}\};/, 'reapplyQueueRowTint'),
  // Item 1.2 — queue triage status bar (docs/plans/TRIAGE-LENS-2026-07-02.md).
  extract(
    /const computeQueueTriageCounts = \(durableMap, cache, visibleRowIndexes, now\) => \{[\s\S]*?\n {2}\};/,
    'computeQueueTriageCounts'
  ),
  extract(
    /const nextAlertRowIndex = \(currentPos, redIndexes, amberIndexes\) => \{[\s\S]*?\n {2}\};/,
    'nextAlertRowIndex'
  ),
  extract(/const getQueueTintedRowIndexes = \(\) => \{[\s\S]*?\n {2}\};/, 'getQueueTintedRowIndexes'),
  extract(/const QUEUE_STATUS_BAR_ID = .*;/, 'QUEUE_STATUS_BAR_ID'),
  extract(/const QUEUE_STATUS_FLASH_CLASS = .*;/, 'QUEUE_STATUS_FLASH_CLASS'),
  extract(/const QUEUE_FOCUS_CLASS = .*;/, 'QUEUE_FOCUS_CLASS'),
  extract(/const QUEUE_STATUS_TOOLTIP =[\s\S]*?;/, 'QUEUE_STATUS_TOOLTIP'),
  extract(
    /let _queueStatusJumpPos = null;[\s\S]*?let _queueStatusBarRafPending = false;/,
    '_queueStatus* module state'
  ),
  // Focus-alerts practice-features pack gate (2026-09-10) — window.PracticePacks
  // is intentionally absent from the sandbox (not stubbed below), same as any
  // other real-browser page where practice-packs.js failed to load: both
  // FOCUS_ALERTS_PACK_KEY's ternary and _focusAlertsPackOn's `!window.PracticePacks
  // || ...` short-circuit to the safe always-on default without throwing.
  extract(
    /const FOCUS_ALERTS_PACK_KEY =[\s\S]*?let _focusAlertsPackOn = !window\.PracticePacks \|\| window\.PracticePacks\.peek\(FOCUS_ALERTS_PACK_KEY\);/,
    'FOCUS_ALERTS_PACK_KEY / _focusAlertsPackOn'
  ),
  extract(/const onQueueStatusJumpClick = \(\) => \{[\s\S]*?\n {2}\};/, 'onQueueStatusJumpClick'),
  extract(/const onQueueStatusFocusClick = \(e\) => \{[\s\S]*?\n {2}\};/, 'onQueueStatusFocusClick'),
  extract(/const ensureQueueStatusBarEl = \(\) => \{[\s\S]*?\n {2}\};/, 'ensureQueueStatusBarEl'),
  extract(/const removeQueueStatusBar = \(\) => \{[\s\S]*?\n {2}\};/, 'removeQueueStatusBar'),
  extract(/const applyQueueFocusClass = \(\) => \{[\s\S]*?\n {2}\};/, 'applyQueueFocusClass'),
  extract(/const renderQueueStatusBar = \(\) => \{[\s\S]*?\n {2}\};/, 'renderQueueStatusBar'),
  extract(/const updateQueueStatusBar = \(\) => \{[\s\S]*?\n {2}\};/, 'updateQueueStatusBar'),
  // Items 2.1/2.3/2.5 (TRIAGE-LENS-2026-07-02.md) — ranked/collapsed
  // rule-match chips (decorateOneRow's rule-chip section) + the rule-match
  // evidence/actions menu they open. Item 3.4 adds the qualifier consts +
  // extends rankRuleMatches to a block-bodied arrow fn (previewText param).
  extract(/const RULE_KIND_RANK = \{[\s\S]*?\};/, 'RULE_KIND_RANK'),
  extract(/const RULE_QUALIFIER_EVIDENCE_CAP = .*;/, 'RULE_QUALIFIER_EVIDENCE_CAP'),
  extract(/const RULE_QUALIFIER_LABEL = \{[\s\S]*?\};/, 'RULE_QUALIFIER_LABEL'),
  extract(/const RULE_QUALIFIER_ARIA = \{[\s\S]*?\};/, 'RULE_QUALIFIER_ARIA'),
  extract(/const rankRuleMatches = \(rules, previewText\) => \{[\s\S]*?\n {2}\};/, 'rankRuleMatches'),
  extract(/const buildRuleMatchChipEl = \(chip\) => \{[\s\S]*?\n {2}\};/, 'buildRuleMatchChipEl'),
  extract(/let activeActionMenu = null;[\s\S]*?let activeAnchorEl = null;/, 'activeActionMenu/activeAnchorEl state'),
  extract(/const closeActionMenu = \(\) => \{[\s\S]*?\n {2}\};/, 'closeActionMenu'),
  extract(/const onDocClickForMenu = \(e\) => \{[\s\S]*?\n {2}\};/, 'onDocClickForMenu'),
  extract(/const onKeydownForMenu = \(e\) => \{[\s\S]*?\n {2}\};/, 'onKeydownForMenu'),
  extract(/const onScrollForMenu = \(e\) => \{[\s\S]*?\n {2}\};/, 'onScrollForMenu'),
  extract(/const armActionMenuDismissal = \(\) => \{[\s\S]*?\n {2}\};/, 'armActionMenuDismissal'),
  extract(/const isSafeActionUrl = \(url\) => \{[\s\S]*?\n {2}\};/, 'isSafeActionUrl'),
  extract(/const executeAction = \(action, anchorEl, menuEl\) => \{[\s\S]*?\n {2}\};/, 'executeAction'),
  extract(/const buildEvidenceEl = \(rule, previewText\) => \{[\s\S]*?\n {2}\};/, 'buildEvidenceEl'),
  extract(/const RULE_MENU_ACTION_ICONS = \{[\s\S]*?\};/, 'RULE_MENU_ACTION_ICONS'),
  extract(/const renderRuleMenuActionItems = \(rule\) => \{[\s\S]*?\n {2}\};/, 'renderRuleMenuActionItems'),
  extract(
    /const renderRuleMenuDetail = \(rule, previewText, rules, showBack\) => \{[\s\S]*?\n {2}\};/,
    'renderRuleMenuDetail'
  ),
  extract(/const renderRuleMenuList = \(rules, previewText\) => \{[\s\S]*?\n {2}\};/, 'renderRuleMenuList'),
  extract(
    /const showRuleMatchMenu = \(anchor, rules, previewText, openList\) => \{[\s\S]*?\n {2}\};/,
    'showRuleMatchMenu'
  ),
  // Items 4.1/4.2 (TRIAGE-LENS-2026-07-02.md) — Pharmacy First divert chip +
  // missing-info ask-back: the pathway menu built on top of the SAME
  // activeActionMenu/renderRuleMenuActionItems/executeAction infra just
  // extracted above. decorateOneRow's own pathway-chip computation needs no
  // separate extraction — it lives INSIDE decorateOneRow's already-extracted
  // body. `_receptionPathwaysData`/`_receptionPathwaysFetchStarted` and
  // `ensureReceptionPathwaysLoaded` are DELIBERATELY NOT extracted (same
  // "externally-provided global" convention as `_durableRowMap`/
  // `_queueResultCache` above) — the harness pre-seeds
  // `sandbox._receptionPathwaysData` directly rather than exercising the
  // fetch pipeline (out of scope here, same as `loadMonitoringRules` above).
  extract(
    /const buildCopySnippetActionsEl = \(text, label\) =>[\s\S]*?\n {4}renderRuleMenuActionItems\(\{ actions: \[\{ type: 'snippet', label, text \}\] \}\);/,
    'buildCopySnippetActionsEl'
  ),
  extract(
    /const buildPharmacyFirstRedirectText = \(pathway, pfElig\) => \{[\s\S]*?\n {2}\};/,
    'buildPharmacyFirstRedirectText'
  ),
  extract(/const buildPathwayEscalationEl = \(flaggedInText\) => \{[\s\S]*?\n {2}\};/, 'buildPathwayEscalationEl'),
  extract(/const buildPathwaySectionHead = \(label\) => \{[\s\S]*?\n {2}\};/, 'buildPathwaySectionHead'),
  extract(
    /const buildPharmacyFirstSectionEl = \(pathway, pfElig\) => \{[\s\S]*?\n {2}\};/,
    'buildPharmacyFirstSectionEl'
  ),
  extract(
    /const buildAskBackSectionEl = \(pathway, gapsData, closingQuestions\) => \{[\s\S]*?\n {2}\};/,
    'buildAskBackSectionEl'
  ),
  extract(
    /const showPathwayMenu = \(anchor, pathway, previewText, pfElig, gapsData, closingQuestions\) => \{[\s\S]*?\n {2}\};/,
    'showPathwayMenu'
  ),
  // Item 2.4 (TRIAGE-LENS-2026-07-02.md) — detail-page verdict banner: echoes
  // the queue's cached result-triage verdict on the task detail page.
  extract(/const DETAIL_VERDICT_CLASS = .*;/, 'DETAIL_VERDICT_CLASS'),
  extract(
    /let _detailVerdictTaskUuid = null;\s*\n\s*const _detailVerdictAttempted = new Set\(\);/,
    '_detailVerdict* module state'
  ),
  extract(/function detailVerdictState\(entry, now\) \{[\s\S]*?\n {2}\}/, 'detailVerdictState'),
  extract(/function buildDetailVerdictHeadline\(sev\) \{[\s\S]*?\n {2}\}/, 'buildDetailVerdictHeadline'),
  extract(/const detailVerdictHost = .*;/, 'detailVerdictHost'),
  extract(/const removeDetailVerdictBanner = \(\) => \{[\s\S]*?\n {2}\};/, 'removeDetailVerdictBanner'),
  extract(/const buildDetailVerdictEl = \(taskUuid, sev, isError\) => \{[\s\S]*?\n {2}\};/, 'buildDetailVerdictEl'),
  extract(
    /const renderDetailVerdictBanner = \(taskUuid, sev, isError\) => \{[\s\S]*?\n {2}\};/,
    'renderDetailVerdictBanner'
  ),
  extract(/const runDetailVerdict = \(\) => \{[\s\S]*?\n {2}\};/, 'runDetailVerdict'),
  // Item 4.7 (TRIAGE-LENS-2026-07-02.md) — seen-session row dimming.
  extract(/const ROW_SEEN_CLASS = .*;/, 'ROW_SEEN_CLASS'),
  extract(/const _seenTasks = new Set\(\);/, '_seenTasks'),
  extract(/const clearQueueSeenDim = \(\) => \{[\s\S]*?\n {2}\};/, 'clearQueueSeenDim'),
  extract(/const reapplyQueueSeenDim = \(\) => \{[\s\S]*?\n {2}\};/, 'reapplyQueueSeenDim'),
  // Item 4.6 (TRIAGE-LENS-2026-07-02.md) — keyboard triage, plus the
  // jumpToAlertRow helper it shares with item 1.2's status-bar jump button.
  extract(/const jumpToAlertRow = \(fromIndex\) => \{[\s\S]*?\n {2}\};/, 'jumpToAlertRow'),
  extract(/const KBD_CURSOR_CLASS = .*;/, 'KBD_CURSOR_CLASS'),
  extract(/let _kbdCursorRowIndex = null;/, '_kbdCursorRowIndex'),
  extract(/const visibleQueueRowIndexes = \(\) => \{[\s\S]*?\n {2}\};/, 'visibleQueueRowIndexes'),
  extract(/const moveKbdCursor = \(currentIndex, rowIndexes, direction\) => \{[\s\S]*?\n {2}\};/, 'moveKbdCursor'),
  extract(/const clearQueueKbdCursor = \(\) => \{[\s\S]*?\n {2}\};/, 'clearQueueKbdCursor'),
  extract(/const applyQueueKbdCursor = \(\) => \{[\s\S]*?\n {2}\};/, 'applyQueueKbdCursor'),
  extract(/const scrollKbdCursorIntoView = \(\) => \{[\s\S]*?\n {2}\};/, 'scrollKbdCursorIntoView'),
  extract(/const findQueueRowOpenTarget = \(row\) => \{[\s\S]*?\n {2}\};/, 'findQueueRowOpenTarget'),
  extract(/const isQueueKeydownTypingTarget = \(el\) => \{[\s\S]*?\n {2}\};/, 'isQueueKeydownTypingTarget'),
  extract(/const onQueueKeydown = \(e\) => \{[\s\S]*?\n {2}\};/, 'onQueueKeydown'),
];

const EXPOSE = [
  'renderChipHtml',
  'selectResultChips',
  'renderSystemChipHtmlMemo',
  'findQueuePreviewRow',
  'queueChipHost',
  'decorateOneRow',
  'decorateQueueRows',
  'queueScope',
  'injectResultChip',
  'buildResultDetail',
  'formatDetailLine',
  // Item 3.1 — unit-mismatch guard surfacing.
  'formatUnitMismatchLine',
  'UNIT_MISMATCH_CHIP_HTML',
  // Item 3.2 Part B — unclassified-qualitative-positive chip surfacing.
  'buildUnclassifiedChipHtml',
  // Item 4.4 — "all-normal, fileable" queue marker.
  'FILEABLE_CHIP_HTML',
  'closeResultDetailPopover',
  'buildResultDetailPopoverEl',
  'toggleResultDetailPopover',
  'RESULT_ERROR_POPOVER_TEXT',
  // Item 2.7 — guidance actions on result rules.
  'findResultRuleActionsById',
  'buildResultRuleActionsRow',
  'executeAction',
  'reinjectCachedResultChips',
  'injectQueueMonitoringChip',
  'reinjectCachedMonitoringChips',
  'clearQueueRowTint',
  'reapplyQueueRowTint',
  'computeQueueTriageCounts',
  'nextAlertRowIndex',
  'getQueueTintedRowIndexes',
  'onQueueStatusJumpClick',
  'onQueueStatusFocusClick',
  'ensureQueueStatusBarEl',
  'removeQueueStatusBar',
  'applyQueueFocusClass',
  'renderQueueStatusBar',
  'updateQueueStatusBar',
  'rankRuleMatches',
  'RULE_QUALIFIER_LABEL',
  'buildRuleMatchChipEl',
  'closeActionMenu',
  'showRuleMatchMenu',
  'renderRuleMenuList',
  'renderRuleMenuDetail',
  'buildEvidenceEl',
  // Items 4.1/4.2 — Pharmacy First divert chip + missing-info ask-back.
  'buildCopySnippetActionsEl',
  'buildPharmacyFirstRedirectText',
  'buildPathwayEscalationEl',
  'buildPathwaySectionHead',
  'buildPharmacyFirstSectionEl',
  'buildAskBackSectionEl',
  'showPathwayMenu',
  'detailVerdictState',
  'buildDetailVerdictHeadline',
  'removeDetailVerdictBanner',
  'buildDetailVerdictEl',
  'renderDetailVerdictBanner',
  'runDetailVerdict',
  // Item 4.7 — seen-session row dimming.
  'ROW_SEEN_CLASS',
  '_seenTasks',
  'clearQueueSeenDim',
  'reapplyQueueSeenDim',
  // Item 4.6 — keyboard triage.
  'jumpToAlertRow',
  'KBD_CURSOR_CLASS',
  'visibleQueueRowIndexes',
  'moveKbdCursor',
  'clearQueueKbdCursor',
  'applyQueueKbdCursor',
  'scrollKbdCursorIntoView',
  'findQueueRowOpenTarget',
  'isQueueKeydownTypingTarget',
  'onQueueKeydown',
];

let sandbox = null;
if (!parts.some((p) => !p)) {
  const combinedSrc =
    parts.join('\n\n') +
    '\n\n' +
    EXPOSE.map((n) => `this.${n} = ${n};`).join('\n') +
    // Item 2.2 — the popover singleton state lives in module-level `let`s the
    // extracted functions close over; this read-only accessor lets the harness
    // assert open/closed without reaching into the closure.
    '\nthis.__popoverState = () => ({ el: _resultDetailPopoverEl, anchor: _resultDetailPopoverAnchor });' +
    // Item 4.6 — _kbdCursorRowIndex is a module-level `let` the extracted
    // keyboard functions close over (same reasoning as the popover state
    // above): a get/set accessor pair lets the harness both assert its
    // current value AND reset it between scenarios (session-local state that
    // must not leak across Layers).
    '\nthis.__getKbdCursor = () => _kbdCursorRowIndex;' +
    '\nthis.__setKbdCursor = (v) => { _kbdCursorRowIndex = v; };';

  // Externally-provided globals: real content.js reads these off `window`/
  // `CONFIG`/module-level `let`s. We pre-set them as plain mutable
  // properties on the sandbox (NOT re-declared inside combinedSrc), so the
  // extracted functions' free-variable lookups resolve to whatever this
  // test currently has them pointing at, and Node can mutate/reset them
  // between scenarios by reference.
  sandbox = {
    console,
    // Node's vm module gives a fresh context none of the web-platform globals —
    // isSafeActionUrl (used by executeAction, exercised directly in Layer 16, item
    // 2.7) calls `new URL(url)`; without this it would ReferenceError inside its own
    // try/catch and silently always return false. Same fix as test-triage-import-
    // validation.js's `sandbox = { URL }`.
    URL,
    CONFIG: {},
    log: () => {},
    showActionMenu: () => {},
    // matchRules is chip-CONTENT logic (text-pattern rule matching), not
    // injection mechanics — stubbed to "no rule chips" so decorateOneRow's
    // chip set is deterministic and driven only by the age/priority/task-age
    // signals this harness controls directly.
    matchRules: () => [],
    // getSystemChip is likewise chip-CONTENT logic (label templating +
    // enabled/disabled), already covered by selectResultChips/
    // selectMonitoringDue tests elsewhere. Stub carries {id, vars} through
    // into the rendered text so injection-mechanics assertions can still
    // tell WHICH chip landed where.
    getSystemChip: (id, vars) => ({
      kind: 'info',
      text: id + (vars ? ' ' + JSON.stringify(vars) : ''),
      ruleId: 'system:' + id,
      hasActions: false,
    }),
    _chipHtmlMemo: new Map(),
    _durableRowMap: new Map(),
    _queueResultCache: new Map(),
    _queueMonCache: new Map(),
    // Pulse v1 lives outside this harness (own unit tests). Stub the free
    // variables decorateOneRow / inject* / onQueueKeydown now close over so
    // the extracted injection functions still compile and run.
    _pulseOpenByKey: new Map(),
    refreshPulseOnRow: () => {},
    pulseOpenKey: () => null,
    PULSE_ON: 'ch-row-pulse-on',
    PULSE_RED: 'ch-row-pulse-red',
    PULSE_AMBER: 'ch-row-pulse-amber',
    // Items 4.1/4.2 — the CSO-signed reception-pathways ruleset, "externally
    // provided" exactly like _durableRowMap/_queueResultCache above: real
    // content.js fetches this ONCE at bootstrap (ensureReceptionPathwaysLoaded,
    // deliberately not extracted/exercised here — a fetch pipeline, out of
    // scope for this DOM-injection harness). Defaults to null ("not loaded
    // yet") so a scenario that never sets it proves the pathway-chip block is
    // a safe no-op, not a throw; Layer 23 below seeds it with the REAL
    // rules/reception-pathways.json content.
    _receptionPathwaysData: null,
    // Items 4.1/4.2 — executeAction's snippet-action branch reads
    // navigator.clipboard.writeText for the PREPARE-ONLY copy buttons (Copy
    // Pharmacy First message / Copy ask-back draft). Harmless default here
    // (resolves, records nothing); Layer 23 overrides this with a
    // write-tracking mock per scenario.
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    _RESULT_CACHE_TTL: 5 * 60 * 1000,
    // Item 1.1 leg D — error cache entries expire much sooner than a real
    // result so a failed check retries soon (see content.js's own constant).
    _RESULT_ERROR_TTL: 60 * 1000,
    _MON_CACHE_TTL: 5 * 60 * 1000,
    queueObservedContainer: null,
    document: null,
    // Item 1.2's updateQueueStatusBar rAF-coalesces; real content.js falls back to
    // setTimeout(fn,0) when rAF is unavailable, but for deterministic assertions
    // this harness runs the callback synchronously instead (see file-header note).
    requestAnimationFrame: (fn) => fn(),
    // Only used by onQueueStatusJumpClick to remove the flash class after 2.6s,
    // by armActionMenuDismissal (items 2.1/2.3/2.5) to defer registering the
    // outside-click listener, and by item 2.2's deferred dismiss-listener attach —
    // none is a real event pipeline this harness drives, so the deferred callback
    // simply never runs (fire-and-forget).
    setTimeout: () => {},
    // showRuleMatchMenu (items 2.1/2.3/2.5) and toggleResultDetailPopover (item
    // 2.2) position their popovers off window.innerWidth and (de)register
    // scroll-dismiss listeners; the REAL shared matcher is wired in as
    // TriageLensMatch so buildEvidenceEl's
    // window.TriageLensMatch.ruleMatchEvidence(...) call exercises the actual
    // rule-match.js logic under test, not a stub.
    window: {
      innerWidth: 1200,
      addEventListener: () => {},
      removeEventListener: () => {},
      TriageLensMatch: require('./content-scripts/triage-lens/rule-match.js'),
      // Items 4.1/4.2 — the REAL reception-match engine (dual-mode Node
      // require, same pattern as TriageLensMatch above), so showPathwayMenu's
      // buildAskBackText call and decorateOneRow's matchPathways/
      // pharmacyFirstEligibility/redFlagGaps calls exercise the actual engine
      // logic under test, not a stub.
      SentinelReceptionMatch: require('./engine/reception-match.js'),
      // Item 2.4 — runDetailVerdict resolves the detail task's uuid via this,
      // exactly like the OIR/monitoring detail-page paths already do. Each
      // Layer 16 scenario points this at whichever taskUuid it's driving;
      // defaults to "no context" so an unconfigured call is a safe no-op.
      SentinelApiClient: { detectMedicusContext: () => null },
    },
    // Item 2.4 — runDetailVerdict reads location.href only to hand it to
    // SentinelApiClient.detectMedicusContext above (itself stubbed per-scenario),
    // so the exact value here is never asserted on, just needs to exist.
    location: { href: 'https://abc123.medicus.health/abc123/tasks/data/investigation_result/overview/x' },
    // Item 2.4 — findCardByTitle is the (unextracted) card-lookup helper
    // detailVerdictHost() calls; stubbed here as an external global exactly
    // like matchRules/getSystemChip above, so Layer 16 controls the "Task
    // Details" card host directly without needing the full DOM-heading-scan
    // implementation (already covered by its own callers elsewhere).
    findCardByTitle: () => null,
    // Item 2.4 — only reached inside runDetailVerdict's compute-on-miss
    // .then() callback, which no Layer 16 scenario exercises (compute-on-miss
    // wiring is source-verified in test-result-triage-queue.js instead); kept
    // here so an accidental hit fails loudly rather than throwing ReferenceError.
    pageType: () => 'detail',
    computeQueueRowResult: () => Promise.resolve(null),
    QUEUE_RESULT_FETCH_ERROR: Object.freeze({ __chQueueResultError: true }),
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(combinedSrc, sandbox, { filename: 'content-extract.js' });
    check(typeof sandbox.injectResultChip === 'function', 'injectResultChip compiled and callable');
    check(
      typeof sandbox.FILEABLE_CHIP_HTML === 'string' && sandbox.FILEABLE_CHIP_HTML.includes('ch-q-fileable'),
      'FILEABLE_CHIP_HTML compiled — carries the .ch-q-fileable marker class'
    );
    check(typeof sandbox.injectQueueMonitoringChip === 'function', 'injectQueueMonitoringChip compiled and callable');
    check(typeof sandbox.decorateOneRow === 'function', 'decorateOneRow compiled and callable');
    check(typeof sandbox.reinjectCachedResultChips === 'function', 'reinjectCachedResultChips compiled and callable');
    check(
      typeof sandbox.reinjectCachedMonitoringChips === 'function',
      'reinjectCachedMonitoringChips compiled and callable'
    );
    check(typeof sandbox.clearQueueRowTint === 'function', 'clearQueueRowTint compiled and callable');
    check(typeof sandbox.reapplyQueueRowTint === 'function', 'reapplyQueueRowTint compiled and callable');
    check(typeof sandbox.computeQueueTriageCounts === 'function', 'computeQueueTriageCounts compiled and callable');
    check(typeof sandbox.nextAlertRowIndex === 'function', 'nextAlertRowIndex compiled and callable');
    check(typeof sandbox.getQueueTintedRowIndexes === 'function', 'getQueueTintedRowIndexes compiled and callable');
    check(typeof sandbox.ensureQueueStatusBarEl === 'function', 'ensureQueueStatusBarEl compiled and callable');
    check(typeof sandbox.removeQueueStatusBar === 'function', 'removeQueueStatusBar compiled and callable');
    check(typeof sandbox.applyQueueFocusClass === 'function', 'applyQueueFocusClass compiled and callable');
    check(typeof sandbox.renderQueueStatusBar === 'function', 'renderQueueStatusBar compiled and callable');
    check(typeof sandbox.updateQueueStatusBar === 'function', 'updateQueueStatusBar compiled and callable');
    check(typeof sandbox.onQueueStatusJumpClick === 'function', 'onQueueStatusJumpClick compiled and callable');
    check(typeof sandbox.onQueueStatusFocusClick === 'function', 'onQueueStatusFocusClick compiled and callable');
    check(typeof sandbox.rankRuleMatches === 'function', 'rankRuleMatches compiled and callable');
    check(typeof sandbox.findResultRuleActionsById === 'function', 'findResultRuleActionsById compiled and callable');
    check(typeof sandbox.buildResultRuleActionsRow === 'function', 'buildResultRuleActionsRow compiled and callable');
    check(typeof sandbox.showRuleMatchMenu === 'function', 'showRuleMatchMenu compiled and callable');
    // Items 4.1/4.2 — Pharmacy First divert chip + missing-info ask-back.
    check(typeof sandbox.buildCopySnippetActionsEl === 'function', 'buildCopySnippetActionsEl compiled and callable');
    check(
      typeof sandbox.buildPharmacyFirstRedirectText === 'function',
      'buildPharmacyFirstRedirectText compiled and callable'
    );
    check(typeof sandbox.buildPathwayEscalationEl === 'function', 'buildPathwayEscalationEl compiled and callable');
    check(typeof sandbox.buildPathwaySectionHead === 'function', 'buildPathwaySectionHead compiled and callable');
    check(
      typeof sandbox.buildPharmacyFirstSectionEl === 'function',
      'buildPharmacyFirstSectionEl compiled and callable'
    );
    check(typeof sandbox.buildAskBackSectionEl === 'function', 'buildAskBackSectionEl compiled and callable');
    check(typeof sandbox.showPathwayMenu === 'function', 'showPathwayMenu compiled and callable');
    check(typeof sandbox.detailVerdictState === 'function', 'detailVerdictState compiled and callable');
    check(typeof sandbox.buildDetailVerdictHeadline === 'function', 'buildDetailVerdictHeadline compiled and callable');
    check(typeof sandbox.renderDetailVerdictBanner === 'function', 'renderDetailVerdictBanner compiled and callable');
    check(typeof sandbox.runDetailVerdict === 'function', 'runDetailVerdict compiled and callable');
    check(typeof sandbox.clearQueueSeenDim === 'function', 'clearQueueSeenDim compiled and callable');
    check(typeof sandbox.reapplyQueueSeenDim === 'function', 'reapplyQueueSeenDim compiled and callable');
    // Not `instanceof Set` — vm.createContext gives the sandbox its own realm
    // with its own Set constructor, distinct from this file's global Set, so
    // a cross-realm instanceof check would always fail even though the
    // object genuinely is a Set within its own realm. Duck-type instead.
    check(
      typeof sandbox._seenTasks.add === 'function' && typeof sandbox._seenTasks.has === 'function',
      '_seenTasks exposed as a Set-like object'
    );
    check(typeof sandbox.jumpToAlertRow === 'function', 'jumpToAlertRow compiled and callable');
    check(typeof sandbox.visibleQueueRowIndexes === 'function', 'visibleQueueRowIndexes compiled and callable');
    check(typeof sandbox.moveKbdCursor === 'function', 'moveKbdCursor compiled and callable');
    check(typeof sandbox.clearQueueKbdCursor === 'function', 'clearQueueKbdCursor compiled and callable');
    check(typeof sandbox.applyQueueKbdCursor === 'function', 'applyQueueKbdCursor compiled and callable');
    check(typeof sandbox.findQueueRowOpenTarget === 'function', 'findQueueRowOpenTarget compiled and callable');
    check(typeof sandbox.isQueueKeydownTypingTarget === 'function', 'isQueueKeydownTypingTarget compiled and callable');
    check(typeof sandbox.onQueueKeydown === 'function', 'onQueueKeydown compiled and callable');
  } catch (e) {
    check(false, `combined extraction compiled without throwing (${e.message})`);
    sandbox = null;
  }
}

const redSev = {
  level: 'red',
  urgentCount: 1,
  abnormalCount: 1,
  top: { name: 'Potassium', value: '6.8', unit: 'mmol/L' },
  misprioritised: false,
  unmatched: false,
};

const amberSev = {
  level: 'amber',
  urgentCount: 0,
  abnormalCount: 1,
  top: { name: 'Sodium', value: '130', unit: 'mmol/L' },
  misprioritised: false,
  unmatched: false,
};

const noneSev = {
  level: 'none',
  urgentCount: 0,
  abnormalCount: 0,
  top: null,
  misprioritised: false,
  unmatched: false,
};

function freshCaches() {
  sandbox._chipHtmlMemo = new Map();
  sandbox._durableRowMap = new Map();
  sandbox._queueResultCache = new Map();
  sandbox._queueMonCache = new Map();
  sandbox.CONFIG = {}; // PREF('queueRowTint', true) -> true by default (no CONFIG.prefs)
  // Item 4.7 — session-local "opened this session" set; must not leak between
  // Layers/scenarios in this harness the way it deliberately never resets on
  // a real page.
  sandbox._seenTasks.clear();
  // Item 4.6 — keyboard cursor is likewise session-local module state.
  sandbox.__setKbdCursor(null);
}

if (sandbox) {
  // ============================================================
  // Layer 1 — host selection + PREPEND, preview-row layout
  // ============================================================
  console.log('\nLayer 1: host selection + PREPEND (preview-row layout, fixtures/queue-chip-host-current.html shape)');

  {
    freshCaches();
    const rowId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', { class: 'ag-center-cols-container' });
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.injectResultChip(0, redSev);
    check(
      wrap.children.length === 1 && wrap.querySelectorAll('.ch-q-result').length === 0,
      `injectResultChip: result chips are not painted (children ${wrap.children.length})`
    );

    sandbox.injectQueueMonitoringChip(0, { level: 'red', count: 2 });
    check(
      wrap.querySelectorAll('.ch-q-mon').length === 0,
      'injectQueueMonitoringChip: monitoring chips are not painted'
    );
  }

  // ============================================================
  // Layer 2 — decorateOneRow (age/decoration family) host + PREPEND
  // ============================================================
  console.log('\nLayer 2: decorateOneRow (age/decoration, DOM-driven) host + PREPEND');

  {
    freshCaches();
    const rowId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    // dob triggers the child-age chip (age 15 < TH('childAge')=16)
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 2011 (15y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    check(
      wrap.children.length === 2,
      `decorateOneRow: age chip strip hosted in the preview row (2 children, got ${wrap.children.length})`
    );
    check(
      wrap.firstChild && wrap.firstChild.classes.includes('ch-queue-chips'),
      'decorateOneRow: PREPENDED — .ch-queue-chips strip is firstChild ahead of the request text'
    );
    check(master.dataset.chQDec === '1', 'decorateOneRow: marks the row decorated (chQDec=1)');
  }

  // ============================================================
  // Layer 3 — de-dupe: calling the same injector twice must not duplicate
  // ============================================================
  console.log('\nLayer 3: de-dupe — re-injection is idempotent (CLAUDE.md rule #6)');

  {
    freshCaches();
    const rowId = 'cccccccc-dddd-4eee-8fff-000000000000';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.injectResultChip(0, redSev);
    sandbox.injectResultChip(0, redSev); // second call — must be a no-op
    check(
      wrap.querySelectorAll('.ch-q-result').length === 0,
      `injectResultChip: calling twice paints nothing (got ${wrap.querySelectorAll('.ch-q-result').length})`
    );

    sandbox.injectQueueMonitoringChip(0, { level: 'amber', count: 1 });
    sandbox.injectQueueMonitoringChip(0, { level: 'amber', count: 1 });
    check(
      wrap.querySelectorAll('.ch-q-mon').length === 0,
      `injectQueueMonitoringChip: calling twice paints nothing (got ${wrap.querySelectorAll('.ch-q-mon').length})`
    );

    // decorateOneRow's de-dupe is via the dataset flag, not the marker check
    // alone — calling it again on the SAME (still-flagged) row must no-op.
    sandbox.decorateOneRow(master);
    sandbox.decorateOneRow(master);
    check(
      wrap.querySelectorAll('.ch-queue-chips').length === 1,
      `decorateOneRow: calling twice on an already-decorated row does not duplicate (1 .ch-queue-chips strip, got ${wrap.querySelectorAll('.ch-queue-chips').length})`
    );
  }

  // ============================================================
  // Layer 4 — SPA churn: Vue wipes the injected nodes, re-inject path
  // restores them on the RIGHT row from the durable map + caches
  // ============================================================
  console.log('\nLayer 4: SPA churn — wipe all chip nodes, drive the re-inject path, chips come back on the right row');

  {
    freshCaches();
    const rowIdA = 'dddddddd-eeee-4fff-8000-111111111111';
    const rowIdB = 'eeeeeeee-ffff-4000-8111-222222222222';
    const rowA = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdA, dob: '01 Jan 1980 (46y)' });
    const rowB = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdB, dob: '01 Jan 1990 (36y)' });
    const gridRoot = new El('div', {});
    [rowA, rowB].forEach(({ master, detail }) => {
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    // Populate as the bridge task-list event would: durable map + caches,
    // then inject once (normal first paint).
    sandbox._durableRowMap.set(0, rowIdA);
    sandbox._durableRowMap.set(1, rowIdB);
    const sevA = redSev;
    const sevB = { ...redSev, top: { name: 'Sodium', value: '121', unit: 'mmol/L' } };
    sandbox._queueResultCache.set(rowIdA, { sev: sevA, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdB, { sev: sevB, ts: Date.now() });
    sandbox.injectResultChip(0, sevA);
    sandbox.injectResultChip(1, sevB);
    check(
      rowA.wrap.querySelectorAll('.ch-q-result').length === 0 &&
        rowB.wrap.querySelectorAll('.ch-q-result').length === 0,
      'setup: neither row paints a result chip'
    );

    // Vue re-render wipes every foreign node wholesale, exactly like the
    // real regression: strip ALL chip nodes from the grid.
    gridRoot.querySelectorAll('.ch-q-result, .ch-q-mon, .ch-queue-chips').forEach((n) => n.remove());
    check(
      gridRoot.querySelectorAll('.ch-q-result').length === 0,
      'churn: wipe removed every injected result-chip node from the grid'
    );

    // Drive the durable re-inject path (what refreshQueueChips calls).
    sandbox.reinjectCachedResultChips();
    check(
      rowA.wrap.querySelectorAll('.ch-q-result').length === 0,
      'reinjectCachedResultChips: row A result chip stays off (not in this build)'
    );
    check(
      rowB.wrap.querySelectorAll('.ch-q-result').length === 0,
      'reinjectCachedResultChips: row B result chip stays off (not in this build)'
    );
    check(
      !rowA.wrap.querySelector('.ch-q-result'),
      'reinjectCachedResultChips: row A does not paint a cached Potassium severity'
    );
    check(
      !rowB.wrap.querySelector('.ch-q-result'),
      'reinjectCachedResultChips: row B does not paint a cached Sodium severity'
    );

    // Same churn/restore story for the monitoring family.
    sandbox._queueMonCache.set(rowIdA, { result: { level: 'red', count: 1 }, ts: Date.now() });
    sandbox.injectQueueMonitoringChip(0, { level: 'red', count: 1 });
    check(rowA.wrap.querySelectorAll('.ch-q-mon').length === 0, 'setup: row A does not paint a monitoring chip');
    gridRoot.querySelectorAll('.ch-q-mon').forEach((n) => n.remove());
    check(rowA.wrap.querySelectorAll('.ch-q-mon').length === 0, 'churn: monitoring chip wiped');
    sandbox.reinjectCachedMonitoringChips();
    check(
      rowA.wrap.querySelectorAll('.ch-q-mon').length === 0,
      'reinjectCachedMonitoringChips: monitoring chip stays off after churn (not in this build)'
    );

    // And the age/decoration family via the same refreshQueueChips sequence
    // (wipe -> clear decorated flags -> decorateQueueRows).
    sandbox.decorateOneRow(rowA.master);
    check(rowA.wrap.querySelectorAll('.ch-queue-chips').length === 1, 'setup: row A carries its age-chip strip');
    gridRoot.querySelectorAll('.ch-queue-chips').forEach((n) => n.remove());
    delete rowA.master.dataset.chQDec;
    sandbox.decorateQueueRows();
    check(
      rowA.wrap.querySelectorAll('.ch-queue-chips').length === 1,
      'decorateQueueRows: age-chip strip restored after churn (DOM-driven — no cache/durable-map dependency, per CLAUDE.md)'
    );
  }

  // ============================================================
  // Layer 5 — flat fallback host (no preview row): patientName cell,
  // inline width-capped class, still PREPEND
  // ============================================================
  console.log('\nLayer 5: flat fallback host (no preview row) — [col-id="patientName"], inline class, PREPEND');

  {
    freshCaches();
    const rowId = 'ffffffff-0000-4111-8222-333333333333';
    const { master, nameCell } = buildFlatRow({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master); // no detail/preview row at all
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.injectResultChip(0, redSev);
    check(
      nameCell.querySelectorAll('.ch-q-result').length === 0,
      'flat fallback: result chips are not painted in the patient-name cell'
    );
  }

  // ============================================================
  // Layer 6 — v3.69 regression class: chip lands on the row the DURABLE
  // MAP says, never on a row merely because its row-id looks like a UUID
  // ============================================================
  console.log(
    '\nLayer 6: v3.69 regression class — keyed by _durableRowMap, NOT by row-id (even when row-id looks like a UUID)'
  );

  {
    freshCaches();
    // The row's OWN row-id is a plausible-looking UUID — but it is NOT the
    // task's real taskUuid. Per CLAUDE.md: "row-id is NOT the task UUID on
    // real Medicus — do not key off it."
    const rowLookalikeId = '11111111-1111-4111-8111-111111111111';
    const realTaskUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { master, nameCell } = buildFlatRow({ rowIndex: 0, rowId: rowLookalikeId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    // The durable map (written ONLY by the bridge task-list event) says
    // rowIndex 0 -> the REAL taskUuid.
    sandbox._durableRowMap.set(0, realTaskUuid);
    sandbox._queueResultCache.set(realTaskUuid, {
      sev: { ...redSev, top: { name: 'RealAnalyte', value: '9', unit: 'x10^9/L' } },
      ts: Date.now(),
    });
    // Decoy: an entry keyed by the row's OWN row-id (the wrong key, the
    // v3.69 no-op bug's shape). If the code regressed to keying off row-id
    // instead of the durable map, THIS is what would render instead.
    sandbox._queueResultCache.set(rowLookalikeId, {
      sev: {
        level: 'amber',
        urgentCount: 0,
        abnormalCount: 1,
        top: { name: 'DECOY', value: '1', unit: '' },
        misprioritised: false,
        unmatched: false,
      },
      ts: Date.now(),
    });

    sandbox.reinjectCachedResultChips();
    check(nameCell.children.length === 1, 'v3.69 class: no result chip is injected (not in this build)');
    const html = nameCell.firstChild ? nameCell.firstChild.innerHTML : '';
    check(!html.includes('RealAnalyte'), `v3.69 class: durable-map severity is not painted (got: ${html})`);
    check(
      !html.includes('DECOY'),
      `v3.69 class: chip does NOT carry the row-id-keyed decoy severity, "DECOY" (got: ${html})`
    );

    // Same class of check for the monitoring family.
    sandbox._queueMonCache.set(realTaskUuid, { result: { level: 'red', count: 3 }, ts: Date.now() });
    sandbox._queueMonCache.set(rowLookalikeId, { result: { level: 'amber', count: 99 }, ts: Date.now() });
    sandbox.reinjectCachedMonitoringChips();
    const monHtml = nameCell.children.find((c) => c.classes.includes('ch-q-mon'));
    check(!monHtml, 'v3.69 class (monitoring): no monitoring chip is injected (not in this build)');
  }

  // ============================================================
  // Layer 7 — a row with NO durable-map entry gets nothing (defensive:
  // no fallback to row-id, no stale/wrong chip)
  // ============================================================
  console.log('\nLayer 7: row absent from _durableRowMap gets no chip (no row-id fallback)');

  {
    freshCaches();
    const rowId = '22222222-2222-4222-8222-222222222222';
    const { master, nameCell } = buildFlatRow({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    // Cache has an entry keyed by the row's OWN row-id, but the durable map
    // (rowIndex -> taskUuid) has nothing for rowIndex 0.
    sandbox._queueResultCache.set(rowId, { sev: redSev, ts: Date.now() });
    sandbox.reinjectCachedResultChips();
    check(
      nameCell.children.length === 1,
      `no durable-map entry: nothing injected even though a row-id-keyed cache entry exists (got ${nameCell.children.length} children)`
    );
  }

  // ============================================================
  // Layer 7b — "couldn't check" error chip (item 1.1 leg D,
  // TRIAGE-LENS-2026-07-02.md): a genuinely-failed per-row fetch/eval caches
  // { sev: null, error: true, ts } and renders a grey "?" chip — distinct from
  // both a real severity chip and the "still pending" nothing-at-all state.
  // ============================================================
  console.log('\nLayer 7b: "couldn\'t check" error chip — render, de-dupe, churn survival, TTL expiry, never tints');

  {
    // ---- a live (non-expired) error entry renders the grey "?" chip ----
    freshCaches();
    const rowId = '33333333-3333-4333-8333-333333333333';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox._durableRowMap.set(0, rowId);
    sandbox._queueResultCache.set(rowId, { sev: null, error: true, ts: Date.now() });
    sandbox.reinjectCachedResultChips();
    check(
      wrap.querySelectorAll('.ch-q-result').length === 0,
      `error entry: grey chip is not painted from cache (got ${wrap.querySelectorAll('.ch-q-result').length} .ch-q-result spans)`
    );
    check(
      !(wrap.firstChild && wrap.firstChild.classes.includes('ch-q-result')),
      'error entry: no ch-q-result host is prepended from the cache'
    );
    const errHtml = wrap.querySelector('.ch-q-result') ? wrap.querySelector('.ch-q-result').innerHTML : '';
    check(!/ch-chip-error/.test(errHtml), `error entry: no grey error chip is painted (got: ${errHtml})`);
    check(
      !/ch-chip-red|ch-chip-amber|ch-chip-green/.test(errHtml),
      'error entry: chip carries NO clinical severity fill class — never mistaken for a graded result'
    );

    // ---- de-dupe: calling injectResultChip for the error chip twice is a no-op ----
    sandbox.injectResultChip(0, null, rowId, true);
    check(
      wrap.querySelectorAll('.ch-q-result').length === 0,
      'error entry: injectResultChip does not paint an error chip'
    );

    // ---- survives SPA churn via the same durable re-inject path ----
    gridRoot.querySelectorAll('.ch-q-result').forEach((n) => n.remove());
    check(wrap.querySelectorAll('.ch-q-result').length === 0, 'error entry churn: wipe removed the error chip node');
    sandbox.reinjectCachedResultChips();
    check(
      wrap.querySelectorAll('.ch-q-result').length === 0,
      'error entry churn: reinjectCachedResultChips does not restore the grey chip'
    );

    // ---- an EXPIRED error entry (older than _RESULT_ERROR_TTL) renders nothing ----
    freshCaches();
    const rowIdExpired = '44444444-4444-4444-8444-444444444444';
    const rExpired = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdExpired, dob: '01 Jan 1980 (46y)' });
    const gridRoot2 = new El('div', {});
    gridRoot2.appendChild(rExpired.master);
    gridRoot2.appendChild(rExpired.detail);
    sandbox.document = makeDocument(gridRoot2);
    sandbox.queueObservedContainer = gridRoot2;

    sandbox._durableRowMap.set(0, rowIdExpired);
    // ts older than _RESULT_ERROR_TTL (60s) but well inside the normal
    // _RESULT_CACHE_TTL (5min) — proves the error path uses its OWN short TTL,
    // not the long one a real result gets.
    sandbox._queueResultCache.set(rowIdExpired, { sev: null, error: true, ts: Date.now() - 90 * 1000 });
    sandbox.reinjectCachedResultChips();
    check(
      rExpired.wrap.querySelectorAll('.ch-q-result').length === 0,
      'expired error entry: renders NOTHING (treated as not-cached so the scheduler retries it)'
    );

    // ---- an error entry never tints the row (sev stays null throughout) ----
    freshCaches();
    const rowIdTint = '55555555-5555-4555-8555-555555555555';
    const rTint = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdTint, dob: '01 Jan 1980 (46y)' });
    const gridRoot3 = new El('div', {});
    gridRoot3.appendChild(rTint.master);
    gridRoot3.appendChild(rTint.detail);
    sandbox.document = makeDocument(gridRoot3);
    sandbox.queueObservedContainer = gridRoot3;

    sandbox._durableRowMap.set(0, rowIdTint);
    sandbox._queueResultCache.set(rowIdTint, { sev: null, error: true, ts: Date.now() });
    sandbox.reapplyQueueRowTint();
    check(
      !rTint.master.classes.includes('ch-row-sev-red') && !rTint.master.classes.includes('ch-row-sev-amber'),
      'error entry: reapplyQueueRowTint never tints the row (entry.sev stays null for an error entry)'
    );
    check(
      !rTint.detail.classes.includes('ch-row-sev-red') && !rTint.detail.classes.includes('ch-row-sev-amber'),
      'error entry: preview/detail row is not tinted either'
    );
  }

  // ============================================================
  // Layer 8 — severity row tint (item 1.3, TRIAGE-LENS-2026-07-02.md):
  // marker class on .ag-row (+ its preview row), keyed off the SAME durable
  // map/cache as the result chips, cleared+reapplied every churn cycle, gated
  // on prefs.queueRowTint.
  // ============================================================
  console.log('\nLayer 8: severity row tint — cached red/amber, unknown rows, churn, recycled row-index, pref gate');

  {
    // ---- tinted on cached red/amber ----
    freshCaches();
    const rowIdRed = 'a0000000-0000-4000-8000-000000000001';
    const rowIdAmber = 'a0000000-0000-4000-8000-000000000002';
    const rowRed = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRed, dob: '01 Jan 1980 (46y)' });
    const rowAmber = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdAmber, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    [rowRed, rowAmber].forEach(({ master, detail }) => {
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox._durableRowMap.set(0, rowIdRed);
    sandbox._durableRowMap.set(1, rowIdAmber);
    sandbox._queueResultCache.set(rowIdRed, { sev: redSev, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdAmber, { sev: amberSev, ts: Date.now() });

    sandbox.reapplyQueueRowTint();
    check(
      !rowRed.master.classes.includes('ch-row-sev-red'),
      'reapplyQueueRowTint: red-cached master row is not tinted (not in this build)'
    );
    check(
      !rowRed.detail.classes.includes('ch-row-sev-red'),
      'reapplyQueueRowTint: red-cached preview/detail row is not tinted'
    );
    check(
      !rowRed.master.classes.includes('ch-row-sev-amber'),
      'reapplyQueueRowTint: red-cached row does not also carry the amber class'
    );
    check(
      !rowAmber.master.classes.includes('ch-row-sev-amber'),
      'reapplyQueueRowTint: amber-cached master row is not tinted (not in this build)'
    );
    check(
      !rowAmber.detail.classes.includes('ch-row-sev-amber'),
      'reapplyQueueRowTint: amber-cached preview/detail row is not tinted'
    );

    // ---- no tint for unknown rows (no cache entry / null sev / level 'none') ----
    freshCaches();
    const rowIdUnknown1 = 'a0000000-0000-4000-8000-000000000003'; // no durable-map entry at all
    const rowIdUnknown2 = 'a0000000-0000-4000-8000-000000000004'; // durable-map entry, no cache entry
    const rowIdUnknown3 = 'a0000000-0000-4000-8000-000000000005'; // cached but sev===null (failed fetch)
    const rowIdUnknown4 = 'a0000000-0000-4000-8000-000000000006'; // cached, level==='none'
    const rU1 = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdUnknown1, dob: '01 Jan 1980 (46y)' });
    const rU2 = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdUnknown2, dob: '01 Jan 1980 (46y)' });
    const rU3 = buildPreviewRowPair({ rowIndex: 2, rowId: rowIdUnknown3, dob: '01 Jan 1980 (46y)' });
    const rU4 = buildPreviewRowPair({ rowIndex: 3, rowId: rowIdUnknown4, dob: '01 Jan 1980 (46y)' });
    const gridRoot2 = new El('div', {});
    [rU1, rU2, rU3, rU4].forEach(({ master, detail }) => {
      gridRoot2.appendChild(master);
      gridRoot2.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRoot2);
    sandbox.queueObservedContainer = gridRoot2;

    // rowIndex 0: nothing in the durable map at all.
    sandbox._durableRowMap.set(1, rowIdUnknown2); // durable entry, but no cache entry below
    sandbox._durableRowMap.set(2, rowIdUnknown3);
    sandbox._queueResultCache.set(rowIdUnknown3, { sev: null, ts: Date.now() });
    sandbox._durableRowMap.set(3, rowIdUnknown4);
    sandbox._queueResultCache.set(rowIdUnknown4, { sev: noneSev, ts: Date.now() });

    sandbox.reapplyQueueRowTint();
    for (const [label, r] of [
      ['no durable-map entry', rU1],
      ['durable entry but no cache entry', rU2],
      ['cached null sev (failed fetch)', rU3],
      ["cached level 'none'", rU4],
    ]) {
      check(
        !r.master.classes.includes('ch-row-sev-red') && !r.master.classes.includes('ch-row-sev-amber'),
        `reapplyQueueRowTint: ${label} -> master row gets NEITHER tint class (never implies "assessed")`
      );
      check(
        !r.detail.classes.includes('ch-row-sev-red') && !r.detail.classes.includes('ch-row-sev-amber'),
        `reapplyQueueRowTint: ${label} -> preview row gets NEITHER tint class either`
      );
    }

    // ---- tint cleared and reapplied on the churn cycle ----
    freshCaches();
    const rowIdChurn = 'a0000000-0000-4000-8000-000000000007';
    const rowChurn = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdChurn, dob: '01 Jan 1980 (46y)' });
    const gridRoot3 = new El('div', {});
    gridRoot3.appendChild(rowChurn.master);
    gridRoot3.appendChild(rowChurn.detail);
    sandbox.document = makeDocument(gridRoot3);
    sandbox.queueObservedContainer = gridRoot3;

    sandbox._durableRowMap.set(0, rowIdChurn);
    sandbox._queueResultCache.set(rowIdChurn, { sev: redSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();
    check(!rowChurn.master.classes.includes('ch-row-sev-red'), 'churn setup: cached red does not tint the row');

    // Simulate the SAME wipe/reapply sequence refreshQueueChips runs on every
    // Vue re-render — clear must remove it, reapply must restore it (immune to
    // the fact that AG-Grid never actually strips CLASSES the way it strips DOM
    // nodes, so an untested clear() would silently mask a real regression).
    sandbox.clearQueueRowTint();
    check(
      !rowChurn.master.classes.includes('ch-row-sev-red') && !rowChurn.master.classes.includes('ch-row-sev-amber'),
      'clearQueueRowTint: tint classes removed from the row on the wipe half of the cycle'
    );
    check(
      !rowChurn.detail.classes.includes('ch-row-sev-red'),
      'clearQueueRowTint: tint classes removed from the preview row too'
    );
    sandbox.reapplyQueueRowTint();
    check(
      !rowChurn.master.classes.includes('ch-row-sev-red'),
      'reapplyQueueRowTint: tint is not restored after the wipe'
    );

    // ---- recycled row-index with a DIFFERENT taskUuid never keeps the old tint ----
    // AG-Grid reuses row-index DOM nodes for a different patient/task once the
    // queue re-sorts. If clear+reapply didn't run together, row-index 0 could
    // keep yesterday's red tint on today's (calm) patient — the tint analogue
    // of the v3.69 wrong-row chip bug.
    const rowIdNewPatient = 'a0000000-0000-4000-8000-000000000008';
    sandbox._durableRowMap.set(0, rowIdNewPatient); // same row-index, different task
    sandbox._queueResultCache.set(rowIdNewPatient, { sev: amberSev, ts: Date.now() });
    // Full cycle: wipe, then reapply from the now-updated durable map/cache.
    sandbox.clearQueueRowTint();
    sandbox.reapplyQueueRowTint();
    check(
      !rowChurn.master.classes.includes('ch-row-sev-red'),
      "recycled row-index: the OLD patient's red tint is gone"
    );
    check(
      !rowChurn.master.classes.includes('ch-row-sev-amber'),
      "recycled row-index: the new patient's amber severity is not tinted"
    );

    // Recycle again, this time onto a task with NO cached severity at all —
    // the row must end up with NO tint, not a stuck amber from the previous cycle.
    const rowIdNewPatientNoSev = 'a0000000-0000-4000-8000-000000000009';
    sandbox._durableRowMap.set(0, rowIdNewPatientNoSev);
    sandbox.clearQueueRowTint();
    sandbox.reapplyQueueRowTint();
    check(
      !rowChurn.master.classes.includes('ch-row-sev-red') && !rowChurn.master.classes.includes('ch-row-sev-amber'),
      'recycled row-index onto an unassessed task: no tint at all survives (not stuck amber)'
    );

    // ---- pref off = no tint ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueRowTint: false } };
    const rowIdPrefOff = 'a0000000-0000-4000-8000-00000000000a';
    const rowPrefOff = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdPrefOff, dob: '01 Jan 1980 (46y)' });
    const gridRoot4 = new El('div', {});
    gridRoot4.appendChild(rowPrefOff.master);
    gridRoot4.appendChild(rowPrefOff.detail);
    sandbox.document = makeDocument(gridRoot4);
    sandbox.queueObservedContainer = gridRoot4;

    sandbox._durableRowMap.set(0, rowIdPrefOff);
    sandbox._queueResultCache.set(rowIdPrefOff, { sev: redSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();
    check(
      !rowPrefOff.master.classes.includes('ch-row-sev-red') && !rowPrefOff.master.classes.includes('ch-row-sev-amber'),
      'prefs.queueRowTint=false: reapplyQueueRowTint is a no-op even though a red-cached row exists'
    );
    sandbox.CONFIG = {}; // restore default for any tests that might run after this block
  }

  // ============================================================
  // Layer 9 — computeQueueTriageCounts (item 1.2, TRIAGE-LENS-2026-07-02.md):
  // pure counting function, all five buckets + TTL expiry moving an entry
  // from a live bucket (error/red) into "checking", + taskUuid dedupe.
  // ============================================================
  console.log(
    '\nLayer 9: computeQueueTriageCounts — five buckets, TTL expiry, dedupe-by-taskUuid, unmapped visible rows'
  );

  {
    const NOW = 1750000000000; // fixed epoch — deterministic TTL-boundary maths
    const durableMap = new Map([
      [0, 'red1'],
      [1, 'amber1'],
      [2, 'clearNone'],
      [3, 'clearNull'],
      [4, 'errFresh'],
      [5, 'errExpired'],
      [6, 'neverFetched'],
      [7, 'noEntry'],
      [8, 'resultExpired'],
      [9, 'red1'], // duplicate taskUuid of row 0 — must dedupe to nothing extra
    ]);
    const cache = new Map([
      ['red1', { sev: redSev, ts: NOW }],
      ['amber1', { sev: amberSev, ts: NOW }],
      ['clearNone', { sev: noneSev, ts: NOW }],
      ['clearNull', { sev: null, ts: NOW }], // definitive "nothing to check", not an error
      ['errFresh', { sev: null, error: true, ts: NOW }],
      // Older than _RESULT_ERROR_TTL (60s) but well inside _RESULT_CACHE_TTL —
      // proves the error bucket uses its OWN short TTL, same as the tint code.
      ['errExpired', { sev: null, error: true, ts: NOW - 90 * 1000 }],
      ['neverFetched', {}], // entry exists, but sev was never set (undefined)
      // 'noEntry' deliberately has NO cache entry at all.
      // Older than _RESULT_CACHE_TTL (5min) — a real result that's gone stale.
      ['resultExpired', { sev: redSev, ts: NOW - 6 * 60 * 1000 }],
    ]);
    // Row 10 is visible in the DOM but the bridge hasn't resolved its taskUuid
    // yet (no durable-map entry) — must count as "checking", not be dropped.
    const visible = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const counts = sandbox.computeQueueTriageCounts(durableMap, cache, visible, NOW);
    check(counts.red === 1, `red bucket: fresh cached red result (got ${counts.red})`);
    check(counts.amber === 1, `amber bucket: fresh cached amber result (got ${counts.amber})`);
    check(counts.clear === 1, `clear bucket: ONLY a fresh level:'none' result counts (got ${counts.clear})`);
    check(
      counts.noResult === 1,
      'noResult bucket: a fresh definitive sev:null non-error entry (nothing to grade) is NOT clear ' +
        `and NOT checking — own non-rendered bucket (got ${counts.noResult})`
    );
    check(counts.error === 1, `couldn't-check bucket: only the FRESH error entry counts (got ${counts.error})`);
    check(
      counts.checking === 5,
      'checking bucket: expired error (TTL moved error->checking) + never-fetched + no-cache-entry + ' +
        `expired result + unmapped-visible-row, all five land here (got ${counts.checking})`
    );
    check(
      counts.total === 10,
      `total: 10 distinct rows counted — the duplicate-taskUuid row (9) contributes to NEITHER bucket NOR the ` +
        `total once its taskUuid has already been seen (got ${counts.total})`
    );

    // ---- explicit "TTL expiry moves an entry from error -> checking" before/after ----
    const errEntry = new Map([['e1', { sev: null, error: true, ts: NOW }]]);
    const errMap = new Map([[0, 'e1']]);
    const before = sandbox.computeQueueTriageCounts(errMap, errEntry, new Set([0]), NOW);
    check(before.error === 1 && before.checking === 0, 'TTL boundary: a fresh error entry counts as "couldn\'t check"');
    const after = sandbox.computeQueueTriageCounts(errMap, errEntry, new Set([0]), NOW + 61 * 1000);
    check(
      after.error === 0 && after.checking === 1,
      'TTL boundary: the SAME entry, 61s later (past _RESULT_ERROR_TTL), moves to "checking" instead'
    );

    // ---- empty union: no known rows at all -> every bucket zero ----
    const empty = sandbox.computeQueueTriageCounts(new Map(), new Map(), new Set(), NOW);
    check(
      empty.red === 0 &&
        empty.amber === 0 &&
        empty.clear === 0 &&
        empty.error === 0 &&
        empty.checking === 0 &&
        empty.total === 0,
      'empty union: no durable-map entries and no visible rows -> every bucket is zero'
    );
  }

  // ============================================================
  // Layer 10 — nextAlertRowIndex (item 1.2): pure jump-order logic — red
  // priority, amber fallback, ascending cycling, wrap-around, both-empty.
  // ============================================================
  console.log('\nLayer 10: nextAlertRowIndex — red priority, amber fallback, ascending cycle, wrap, disabled case');

  {
    check(sandbox.nextAlertRowIndex(null, [], []) === null, 'both lists empty: returns null (caller disables button)');
    check(
      sandbox.nextAlertRowIndex(null, [3, 7, 9], []) === 3,
      'no current position: jumps to the FIRST (lowest row-index) red'
    );
    check(sandbox.nextAlertRowIndex(3, [3, 7, 9], []) === 7, 'cycles ascending: from 3 to the next red, 7');
    check(sandbox.nextAlertRowIndex(9, [3, 7, 9], []) === 3, 'wraps around: from the LAST red back to the first');
    check(
      sandbox.nextAlertRowIndex(100, [3, 7, 9], []) === 3,
      'current position past every red (stale/scrolled away): wraps to the first rather than returning null'
    );
    check(sandbox.nextAlertRowIndex(null, [], [2, 5]) === 2, 'zero reds: falls back to the first amber');
    check(sandbox.nextAlertRowIndex(2, [], [2, 5]) === 5, 'zero reds: amber list cycles the same way reds do');
    check(
      sandbox.nextAlertRowIndex(0, [4], [1, 2, 3]) === 4,
      'ANY reds present, even just one, take priority over ambers — never mixes the two lists'
    );
  }

  // ============================================================
  // Layer 11 — queue status bar: create-once/mutate-in-place, de-dupe,
  // omitted-zero-segments text, "still checking" indicator, PREF gate,
  // tooltip carries the honesty line, rAF-coalesced updateQueueStatusBar.
  // ============================================================
  console.log('\nLayer 11: queue status bar — render, de-dupe, update-in-place, omitted segments, PREF gate');

  {
    freshCaches();
    const rowIdRed = 'b0000000-0000-4000-8000-000000000001';
    const { master, detail } = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRed, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;
    sandbox._durableRowMap.set(0, rowIdRed);
    sandbox._queueResultCache.set(rowIdRed, { sev: redSev, ts: Date.now() });

    sandbox.renderQueueStatusBar();
    const bar1 = sandbox.document.getElementById('ch-q-status-bar');
    check(!!bar1, 'renderQueueStatusBar: bar element created and appended');
    check(bar1 && bar1.classes.includes('ch-q-status'), 'bar carries the ch-q-status class');
    check(bar1 && bar1.attrs.role === 'status', 'bar has role="status"');
    check(bar1 && bar1.attrs['aria-live'] === 'off', 'bar has aria-live="off" (counts change too often for "polite")');
    check(
      bar1 && /not been assessed as normal/.test(bar1.title || ''),
      "bar tooltip carries the old legend's honesty line"
    );
    const countsEl1 = bar1 && bar1.querySelector('.ch-q-status-counts');
    check(
      countsEl1 && countsEl1.textContent === '1 red · 0 amber',
      `bar text with only a red present, zero everything else: "1 red · 0 amber", zero segments omitted (got: ${countsEl1 && countsEl1.textContent})`
    );
    check(
      !bar1.classes.includes('ch-q-status--checking'),
      'no checking rows: the "still working" indicator class is absent'
    );

    sandbox.renderQueueStatusBar();
    const bar2 = sandbox.document.getElementById('ch-q-status-bar');
    check(bar2 === bar1, 'de-dupe: calling renderQueueStatusBar again does not create a second bar node');
    check(
      sandbox.document.querySelectorAll('.ch-q-status').length === 1,
      'de-dupe: exactly one .ch-q-status element exists in the document'
    );

    // ---- update-in-place: same node reference, text mutates to reflect a new picture ----
    const rowIdAmber = 'b0000000-0000-4000-8000-000000000002';
    const rowAmber = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdAmber, dob: '01 Jan 1980 (46y)' });
    gridRoot.appendChild(rowAmber.master);
    gridRoot.appendChild(rowAmber.detail);
    sandbox._durableRowMap.set(1, rowIdAmber);
    sandbox._queueResultCache.set(rowIdAmber, { sev: null, error: true, ts: Date.now() }); // "couldn't check"
    sandbox.renderQueueStatusBar();
    const bar3 = sandbox.document.getElementById('ch-q-status-bar');
    check(bar3 === bar1, 'update-in-place: still the SAME node reference after the underlying counts changed');
    const countsEl3 = bar3.querySelector('.ch-q-status-counts');
    check(
      countsEl3.textContent === '1 red · 0 amber · 1 ?',
      `bar text updates in place to include the new "?" segment, clear stays omitted (got: ${countsEl3.textContent})`
    );

    // ---- "still checking" — a known row with no live cache entry ----
    const rowIdChecking = 'b0000000-0000-4000-8000-000000000003';
    const rowChecking = buildPreviewRowPair({ rowIndex: 2, rowId: rowIdChecking, dob: '01 Jan 1980 (46y)' });
    gridRoot.appendChild(rowChecking.master);
    gridRoot.appendChild(rowChecking.detail);
    sandbox._durableRowMap.set(2, rowIdChecking); // no cache entry at all yet
    sandbox.renderQueueStatusBar();
    const bar4 = sandbox.document.getElementById('ch-q-status-bar');
    const countsEl4 = bar4.querySelector('.ch-q-status-counts');
    check(
      countsEl4.textContent === '1 red · 0 amber · 1 ? · checking 1…',
      `"checking" segment appended last, with the ellipsis (got: ${countsEl4.textContent})`
    );
    check(
      bar4.classes.includes('ch-q-status--checking'),
      'checking > 0: the "still working" indicator class is present'
    );

    // ---- PREF gate: prefs.queueStatusBar=false removes the bar ----
    sandbox.CONFIG = { prefs: { queueStatusBar: false } };
    sandbox.renderQueueStatusBar();
    check(
      sandbox.document.getElementById('ch-q-status-bar') === null,
      'prefs.queueStatusBar=false: renderQueueStatusBar removes any existing bar and renders nothing'
    );
    sandbox.CONFIG = {};

    // ---- updateQueueStatusBar: rAF-coalesced — N calls in one frame render ONCE ----
    freshCaches();
    const rowIdCoalesce = 'b0000000-0000-4000-8000-000000000004';
    const rowCoalesce = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdCoalesce, dob: '01 Jan 1980 (46y)' });
    const gridRootC = new El('div', {});
    gridRootC.appendChild(rowCoalesce.master);
    gridRootC.appendChild(rowCoalesce.detail);
    sandbox.document = makeDocument(gridRootC);
    sandbox.queueObservedContainer = gridRootC;
    sandbox._durableRowMap.set(0, rowIdCoalesce);
    sandbox._queueResultCache.set(rowIdCoalesce, { sev: redSev, ts: Date.now() });

    let rafCalls = 0;
    const queuedRaf = [];
    sandbox.requestAnimationFrame = (fn) => {
      rafCalls++;
      queuedRaf.push(fn);
    };
    sandbox.updateQueueStatusBar();
    sandbox.updateQueueStatusBar();
    sandbox.updateQueueStatusBar();
    check(
      rafCalls === 1,
      `three updateQueueStatusBar() calls before a frame runs schedule only ONE rAF (got ${rafCalls})`
    );
    check(
      sandbox.document.getElementById('ch-q-status-bar') === null,
      'nothing rendered yet — the coalesced render is still pending the (stubbed) animation frame'
    );
    queuedRaf.forEach((fn) => fn());
    check(
      !!sandbox.document.getElementById('ch-q-status-bar'),
      'once the frame runs, the coalesced render has happened'
    );
    sandbox.updateQueueStatusBar();
    check(
      rafCalls === 2,
      'after the pending flag is cleared, a further call schedules a new rAF (not swallowed forever)'
    );
    queuedRaf.pop()();
    sandbox.requestAnimationFrame = (fn) => fn(); // restore the synchronous stub for later layers
  }

  // ============================================================
  // Layer 12 — focus-alerts toggle (item 1.2): class on document.body (the
  // stable element, per applyQueueFocusClass's own reasoning), button
  // ARIA/visual state, OFF by default, and the class-composition proof that
  // the dim CSS rule excludes tinted rows (including preview rows).
  // ============================================================
  console.log('\nLayer 12: focus-alerts toggle — body class, button ARIA state, OFF by default, tint-class exclusion');

  {
    freshCaches();
    const rowIdRed = 'c0000000-0000-4000-8000-000000000001';
    const rowIdCalm = 'c0000000-0000-4000-8000-000000000002';
    const rowRed = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRed, dob: '01 Jan 1980 (46y)' });
    const rowCalm = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdCalm, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    [rowRed, rowCalm].forEach(({ master, detail }) => {
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;
    sandbox._durableRowMap.set(0, rowIdRed);
    sandbox._queueResultCache.set(rowIdRed, { sev: redSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint(); // rowRed (+ its preview row) now carries ch-row-sev-red; rowCalm carries neither

    sandbox.renderQueueStatusBar();
    const bar = sandbox.document.getElementById('ch-q-status-bar');
    const focusBtn = bar.querySelector('.ch-q-status-focus');
    check(!!focusBtn, 'status bar has a focus-alerts button');
    check(focusBtn.attrs['aria-pressed'] === 'false', 'focus-alerts starts OFF (aria-pressed=false) by default');
    check(
      !sandbox.document.body.classes.includes('ch-q-focus-alerts'),
      'OFF by default: document.body does not carry the focus class yet'
    );

    sandbox.onQueueStatusFocusClick({ currentTarget: focusBtn });
    check(
      sandbox.document.body.classes.includes('ch-q-focus-alerts'),
      'clicking focus-alerts adds the class to document.body — the stable element, not the (re-buildable) grid container'
    );
    check(focusBtn.attrs['aria-pressed'] === 'true', 'button aria-pressed flips to true');
    check(focusBtn.classes.includes('ch-q-status-btn-active'), 'button gets the active visual class');

    // ---- class-composition proof for the dim CSS rule ----
    // `.ch-q-focus-alerts .ag-row:not(.ch-row-sev-red):not(.ch-row-sev-amber)` —
    // assert the class SETS the rule keys off, not computed opacity (per task).
    check(
      rowCalm.master.classes.includes('ag-row') &&
        !rowCalm.master.classes.includes('ch-row-sev-red') &&
        !rowCalm.master.classes.includes('ch-row-sev-amber'),
      'untinted row: carries neither tint class, so the :not()/:not() dim selector MATCHES it (would be dimmed)'
    );
    check(
      !rowRed.master.classes.includes('ch-row-sev-red'),
      'result tint is not in this build: a red-cached master row is not marked ch-row-sev-red'
    );
    check(
      !rowRed.detail.classes.includes('ch-row-sev-red'),
      'result tint is not in this build: the preview row is not marked either'
    );

    sandbox.onQueueStatusFocusClick({ currentTarget: focusBtn });
    check(
      !sandbox.document.body.classes.includes('ch-q-focus-alerts'),
      'clicking again removes the class from document.body'
    );
    check(focusBtn.attrs['aria-pressed'] === 'false', 'button aria-pressed flips back to false');
    check(!focusBtn.classes.includes('ch-q-status-btn-active'), 'button loses the active visual class');

    // A brand-new bar element (bar torn down + recreated across a queue re-visit)
    // must reflect the CURRENT toggle state on its own fresh button, not always
    // default to OFF — renderQueueStatusBar syncs this every render.
    sandbox.onQueueStatusFocusClick({ currentTarget: focusBtn }); // toggle back ON
    sandbox.removeQueueStatusBar();
    sandbox.renderQueueStatusBar();
    const bar2 = sandbox.document.getElementById('ch-q-status-bar');
    const focusBtn2 = bar2.querySelector('.ch-q-status-focus');
    check(
      focusBtn2.attrs['aria-pressed'] === 'true',
      'a freshly (re)created bar syncs its focus button to the still-ON session-local toggle state'
    );
    sandbox.onQueueStatusFocusClick({ currentTarget: focusBtn2 }); // leave state OFF for later layers

    // ---- practice-packs gate (a colleague's request, 2026-09-10; corrected same
    // day to cover the WHOLE bar, not just this button): with no
    // window.PracticePacks (this harness's default sandbox), _focusAlertsPackOn
    // stays at its grandfathered-ON fallback for the process lifetime — the
    // real bindInjector on/off lifecycle only runs behind `window.PracticePacks
    // && window.PracticePacks.bindInjector`, which is deliberately not stubbed
    // here (this harness tests injection mechanics, not the pack plumbing
    // itself — that's covered by source-pattern checks in
    // test-practice-features.js, matching every other bindInjector-gated
    // pack in this codebase). This just confirms the default-ON fallback
    // leaves the whole bar intact.
    check(!!bar2, 'default sandbox (no window.PracticePacks): the status bar still renders — grandfathered ON');
    check(!focusBtn2.hidden, 'and the focus button within it is visible');
  }

  // ============================================================
  // Layer 13 — jump-to-next-alert button (item 1.2): scrollIntoView + flash
  // on the right row (and its preview row), ascending cycle order, wrap,
  // jump-cycle reset when the aggregate red/amber picture materially changes,
  // disabled/label state.
  // ============================================================
  console.log(
    '\nLayer 13: jump-to-next-alert — scrollIntoView + flash, ascending cycle, wrap, reset-on-material-change'
  );

  {
    freshCaches();
    const rowIdRedA = 'd0000000-0000-4000-8000-000000000001'; // row-index 0
    const rowIdAmber = 'd0000000-0000-4000-8000-000000000002'; // row-index 1
    const rowIdRedB = 'd0000000-0000-4000-8000-000000000003'; // row-index 2
    const rowRedA = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRedA, dob: '01 Jan 1980 (46y)' });
    const rowAmber = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdAmber, dob: '01 Jan 1980 (46y)' });
    const rowRedB = buildPreviewRowPair({ rowIndex: 2, rowId: rowIdRedB, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    [rowRedA, rowAmber, rowRedB].forEach(({ master, detail }) => {
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;
    sandbox._durableRowMap.set(0, rowIdRedA);
    sandbox._durableRowMap.set(1, rowIdAmber);
    sandbox._durableRowMap.set(2, rowIdRedB);
    sandbox._queueResultCache.set(rowIdRedA, { sev: redSev, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdAmber, { sev: amberSev, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdRedB, { sev: redSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();

    const scrollCalls = { a: [], b: [] };
    rowRedA.master.scrollIntoView = (opts) => scrollCalls.a.push(opts);
    rowRedB.master.scrollIntoView = (opts) => scrollCalls.b.push(opts);

    sandbox.renderQueueStatusBar();
    const jumpBtn = sandbox.document.getElementById('ch-q-status-bar').querySelector('.ch-q-status-jump');
    check(jumpBtn.disabled, 'cached result severities do not enable jump (result tint is not in this build)');
    check(
      jumpBtn.textContent === '▶ red',
      'the jump label can still name red from the count, but the button stays disabled'
    );

    sandbox.onQueueStatusJumpClick();
    sandbox.onQueueStatusJumpClick();
    sandbox.onQueueStatusJumpClick();
    check(scrollCalls.a.length === 0 && scrollCalls.b.length === 0, 'jump does not scroll a row that was not tinted');
    check(!rowRedA.master.classes.includes('ch-q-status-flash'), 'an untinted cached-red row is not flashed');
    check(!rowRedA.detail.classes.includes('ch-q-status-flash'), 'the preview row is not flashed either');

    // ---- reset-on-material-change: a new red row changes the aggregate picture ----
    const rowIdRedC = 'd0000000-0000-4000-8000-000000000004';
    const rowRedC = buildPreviewRowPair({ rowIndex: 3, rowId: rowIdRedC, dob: '01 Jan 1980 (46y)' });
    gridRoot.appendChild(rowRedC.master);
    gridRoot.appendChild(rowRedC.detail);
    sandbox._durableRowMap.set(3, rowIdRedC);
    sandbox._queueResultCache.set(rowIdRedC, { sev: redSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();
    const scrollCallsC = [];
    rowRedC.master.scrollIntoView = (opts) => scrollCallsC.push(opts);

    // Without a render in between, the cycle would simply continue (row 0 was
    // the last jump target -> next ascending red is row 2). Rendering first is
    // what detects the red-count change (3 -> 4) and resets the cycle.
    sandbox.renderQueueStatusBar();
    sandbox.onQueueStatusJumpClick();
    check(
      scrollCalls.a.length === 0 && scrollCalls.b.length === 0 && scrollCallsC.length === 0,
      'a newly cached red row is still not jumped to'
    );

    // ---- zero alerts: button disabled, safe no-op click ----
    freshCaches();
    const rowIdCalm = 'd0000000-0000-4000-8000-000000000005';
    const rowCalm = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdCalm, dob: '01 Jan 1980 (46y)' });
    const gridRoot2 = new El('div', {});
    gridRoot2.appendChild(rowCalm.master);
    gridRoot2.appendChild(rowCalm.detail);
    sandbox.document = makeDocument(gridRoot2);
    sandbox.queueObservedContainer = gridRoot2;
    sandbox._durableRowMap.set(0, rowIdCalm);
    sandbox._queueResultCache.set(rowIdCalm, { sev: noneSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();
    sandbox.renderQueueStatusBar();
    const jumpBtn2 = sandbox.document.getElementById('ch-q-status-bar').querySelector('.ch-q-status-jump');
    check(jumpBtn2.disabled, 'no red or amber rows: jump button is disabled');
    let threw = false;
    try {
      sandbox.onQueueStatusJumpClick();
    } catch (e) {
      threw = true;
    }
    check(
      !threw,
      'clicking the (disabled, but content.js does not rely on the DOM disabled attribute alone) jump handler with nothing to jump to is a safe no-op'
    );
    check(!rowCalm.master.classes.includes('ch-q-status-flash'), 'no-op click: the calm row is never flashed');
  }

  // ============================================================
  // Layer 14 — ranked/collapsed rule-match chips + their evidence menu
  // (items 2.1/2.3/2.5, TRIAGE-LENS-2026-07-02.md)
  // ============================================================
  console.log(
    '\nLayer 14: rule-match chips ranked red<amber<info, collapsed to top+"+N", clickable menu with evidence + list-all'
  );

  const RM = require('./content-scripts/triage-lens/rule-match.js');
  function mkRule(id, kind, label, patterns) {
    return RM.compileRule({
      id,
      label,
      kind,
      enabled: true,
      regex: false,
      patterns,
      fields: ['request'],
      pages: ['queue'],
      builtin: true,
      actions: [{ type: 'note', label: 'Clinical note', text: 'n/a' }],
    });
  }
  const ruleRed = mkRule('r-red', 'red', 'Sepsis flag', ['fever']);
  const ruleAmber = mkRule('r-amber', 'amber', 'UTI query', ['waterworks']);
  const ruleInfo = mkRule('r-info', 'info', 'Admin query', ['sick note']);
  // Item 4.3 (TRIAGE-LENS-2026-07-02.md) — the green routine tier. Ranks LAST
  // (below info): green is "confidently routine, nothing to check", so it must
  // never outrank even an informational chip — it's only ever the top chip
  // when NO red/amber/info rule ALSO matched the same request text.
  const ruleGreen = mkRule('r-green', 'green', 'Admin details query', ['change of address']);
  const multiRulePreviewText = 'Patient has a fever and waterworks symptoms, also wants a sick note.';

  {
    // ---- pure ranking: red < amber < info < green regardless of match order ----
    const ranked = sandbox.rankRuleMatches([ruleAmber, ruleInfo, ruleRed]);
    check(
      ranked.map((r) => r.id).join(',') === 'r-red,r-amber,r-info',
      `rankRuleMatches: red < amber < info (got ${ranked.map((r) => r.id).join(',')})`
    );
    // Stable within the same severity: original relative order preserved.
    const ranked2 = sandbox.rankRuleMatches([ruleAmber, ruleRed, ruleInfo, ruleRed]);
    check(
      ranked2[0].id === 'r-red' && ranked2[1].id === 'r-red',
      'rankRuleMatches: ties on severity keep their original relative order (stable sort)'
    );
    // Item 4.3: green sorts after info, last of all four kinds, regardless of
    // input order.
    const rankedGreen = sandbox.rankRuleMatches([ruleGreen, ruleInfo, ruleAmber, ruleRed]);
    check(
      rankedGreen.map((r) => r.id).join(',') === 'r-red,r-amber,r-info,r-green',
      `rankRuleMatches: red < amber < info < green (got ${rankedGreen.map((r) => r.id).join(',')})`
    );
    const rankedGreenAlone = sandbox.rankRuleMatches([ruleGreen]);
    check(
      rankedGreenAlone.length === 1 && rankedGreenAlone[0].id === 'r-green',
      'rankRuleMatches: a green-only match still ranks (never dropped)'
    );
  }

  {
    // ---- decorateOneRow: multiple matched rules -> top chip + "+N" ----
    freshCaches();
    sandbox.matchRules = () => [ruleAmber, ruleInfo, ruleRed]; // deliberately NOT pre-sorted
    const rowId = 'e0000000-0000-4000-8000-000000000001';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
    check(
      ruleChips.length === 2,
      `multi-rule row: exactly 2 rule-match chips rendered (top + "+N"), got ${ruleChips.length}`
    );
  }

  {
    // ---- decorateOneRow: single matched rule -> top chip only, no "+N" ----
    freshCaches();
    sandbox.matchRules = () => [ruleRed];
    const rowId = 'e0000000-0000-4000-8000-000000000002';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
    check(ruleChips.length === 1, `single-rule row: exactly 1 rule-match chip (no overflow), got ${ruleChips.length}`);
    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }

  {
    // ---- Item 4.3: a row matching ONLY a green rule shows the green chip as
    //      top (and only) chip — the collapse mechanics don't special-case
    //      green, so a single green match behaves exactly like a single red/
    //      amber/info match. ----
    freshCaches();
    sandbox.matchRules = () => [ruleGreen];
    const rowId = 'e0000000-0000-4000-8000-000000000003';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
    check(ruleChips.length === 1, `green-only row: exactly 1 rule-match chip (no overflow), got ${ruleChips.length}`);
    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }

  {
    // ---- Item 4.3: a row matching an amber AND a green rule shows amber on
    //      top, green demoted into the "+N" overflow — never the reverse. This
    //      is the escalate-only safety guarantee: a routine-admin phrase never
    //      outranks a genuine clinical match on the SAME row. ----
    freshCaches();
    sandbox.matchRules = () => [ruleGreen, ruleAmber]; // deliberately green-first, not pre-sorted
    const rowId = 'e0000000-0000-4000-8000-000000000004';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
    check(ruleChips.length === 2, `amber+green row: top chip + "+1" overflow chip, got ${ruleChips.length}`);
    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }

  {
    // ---- "+N" click opens the list-all view with every matched rule ----
    freshCaches();
    sandbox.document = makeDocument(new El('div', {}));
    const anchor = new El('span');
    sandbox.showRuleMatchMenu(anchor, [ruleRed, ruleAmber, ruleInfo], multiRulePreviewText, true);
    const menu = sandbox.document.querySelector('.ch-rule-menu');
    check(!!menu, 'showRuleMatchMenu(openList=true): a .ch-rule-menu popover was appended to document.body');
    check(menu.getAttribute('role') === 'menu', 'popover has role="menu"');
    const listItems = menu.querySelectorAll('.ch-rule-menu-list-item');
    check(listItems.length === 3, `list view: one row per matched rule (got ${listItems.length})`);
    const labels = listItems.map((i) => i.textContent).join(' | ');
    check(
      labels.includes('Sepsis flag') && labels.includes('UTI query') && labels.includes('Admin query'),
      `list view: every matched rule's label is present (got: ${labels})`
    );
    listItems.forEach((i) => {
      check(i.getAttribute('role') === 'menuitem', 'each list row has role="menuitem"');
      check(i.getAttribute('tabindex') === '0', 'each list row has tabindex 0');
    });

    // Drilling into a list item shows that rule's own detail (evidence +
    // actions) WITH a back button (came from the list). (This fake DOM's
    // selector engine has no descendant combinator — `.a .b` is parsed as
    // "has both classes on ONE element", not "a .b inside .a" — so drill
    // down in two querySelector steps instead of one compound selector.)
    listItems[1].click(); // UTI query
    const detailHead = menu.querySelector('.ch-action-menu-head');
    const detailBadge = detailHead && detailHead.querySelector('.ch-chip');
    check(
      detailBadge && detailBadge.textContent === 'UTI query',
      `clicking a list row drills into ITS OWN rule's detail view (got badge: ${detailBadge && detailBadge.textContent})`
    );
    check(!!menu.querySelector('.ch-action-back'), 'detail view reached FROM the list carries a "Back" control');
    const evidenceText = menu.querySelector('.ch-rule-menu-evidence-text');
    check(
      !!evidenceText && evidenceText.textContent.includes('waterworks'),
      `drilled-into detail view shows evidence for the CLICKED rule (waterworks), got: ${evidenceText && evidenceText.textContent}`
    );
    const evidenceStrong = evidenceText && evidenceText.querySelector('strong');
    check(!!evidenceStrong, 'evidence text highlights the matched term in a <strong> element');
    check(
      evidenceStrong && evidenceStrong.textContent === 'waterworks',
      `the <strong> element wraps exactly the matched term (got "${evidenceStrong && evidenceStrong.textContent}")`
    );

    // Back returns to the list.
    menu.querySelector('.ch-action-back').click();
    check(
      menu.querySelectorAll('.ch-rule-menu-list-item').length === 3,
      'clicking "Back" from a drilled-into detail view returns to the full list'
    );
  }

  {
    // ---- top-chip click opens detail DIRECTLY (no list, no back button) ----
    freshCaches();
    sandbox.document = makeDocument(new El('div', {}));
    const anchor = new El('span');
    sandbox.showRuleMatchMenu(anchor, [ruleRed, ruleAmber], multiRulePreviewText, false);
    const menu = sandbox.document.querySelector('.ch-rule-menu');
    check(
      menu.querySelectorAll('.ch-rule-menu-list-item').length === 0,
      'top-chip open (openList=false): no list view rendered'
    );
    const topHead = menu.querySelector('.ch-action-menu-head');
    const badge = topHead && topHead.querySelector('.ch-chip');
    check(
      badge && badge.textContent === 'Sepsis flag',
      'top-chip open: detail view is for the TOP (highest-severity) rule directly'
    );
    check(!menu.querySelector('.ch-action-back'), 'top-chip open: no back button (nothing to go back to)');
    const evidenceText = menu.querySelector('.ch-rule-menu-evidence-text');
    check(
      !!evidenceText && evidenceText.textContent.includes('fever'),
      `top-chip open: evidence shown for the top rule (fever), got: ${evidenceText && evidenceText.textContent}`
    );
    check(
      menu.querySelectorAll('.ch-action-menu-item').length === 1,
      'detail view lists the rule\'s configured action(s) (one "note" action fixture)'
    );

    // A rule with NO textual match in the given previewText (defensive case —
    // e.g. stale evidence after the request text changed) shows the "no
    // matching text" fallback rather than throwing or showing nothing.
    const ruleNoMatch = mkRule('r-nomatch', 'amber', 'Unrelated rule', ['xyzxyz-never-present']);
    sandbox.showRuleMatchMenu(anchor, [ruleNoMatch], 'completely different text', false);
    const menu2 = sandbox.document.querySelector('.ch-rule-menu');
    check(
      menu2.querySelector('.ch-rule-menu-evidence-empty') &&
        /no matching text/i.test(menu2.querySelector('.ch-rule-menu-evidence-empty').textContent),
      'no-match case: shows the "no matching text found" fallback instead of throwing'
    );
  }

  {
    // ---- evidence-line-uses-textContent: source-level guard that the
    // request-text evidence path never builds via innerHTML (a prior
    // attribute-injection XSS was fixed in this area; the request text is
    // patient/reception-typed and untrusted). Grep-level assert per the
    // TRIAGE-LENS-2026-07-02.md plan's explicit allowance for this check. ----
    const buildEvidenceElSrc = (src.match(/const buildEvidenceEl = \(rule, previewText\) => \{[\s\S]*?\n {2}\};/) || [
      '',
    ])[0];
    check(buildEvidenceElSrc.length > 0, 'buildEvidenceEl source located for the innerHTML guard');
    check(
      !/\.innerHTML/.test(buildEvidenceElSrc),
      'buildEvidenceEl never assigns .innerHTML — evidence text is built with createElement/textContent/createTextNode only'
    );
    check(
      /createTextNode|\.textContent\s*=/.test(buildEvidenceElSrc),
      'buildEvidenceEl does use textContent/createTextNode to place the (untrusted) request-derived text'
    );
  }
  // ============================================================
  // Layer 15 — result-chip detail popover (item 2.2, TRIAGE-LENS-2026-07-02.md):
  // open/close toggle, singleton behaviour, detail-line rendering via
  // textContent, error-chip explanation popover, anchor-death close, arrow
  // rules on the chip label (item 2.6), detail cached alongside the error flag.
  // ============================================================
  console.log('\nLayer 15: result-chip detail popover — open/close, error variant, anchor death, trend arrows');

  {
    // ---- open: cached detail renders one .ch-result-popover-line per entry, via textContent ----
    freshCaches();
    sandbox.closeResultDetailPopover(); // defensive reset of the singleton state
    const rowId = '66666666-6666-4666-8666-666666666666';
    const { master, detail } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    const detailArr = [
      {
        name: 'Potassium',
        value: 6.2,
        unit: 'mmol/L',
        low: 3.5,
        high: 5.3,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: 'Critical high potassium (red ≥6.5)',
        prior: { value: 4.1, date: '2026-05-03', dir: 'up' },
      },
      {
        name: 'eGFR',
        value: 38,
        unit: 'mL/min',
        low: 90,
        high: null,
        flag: 'below',
        date: '2026-06-12',
        ruleLabel: null,
        prior: null,
      },
    ];
    sandbox._durableRowMap.set(0, rowId);
    sandbox._queueResultCache.set(rowId, { sev: redSev, ts: Date.now(), detail: detailArr });

    const anchor = new El('span', { class: 'ch-chip ch-chip-red' });
    gridRoot.appendChild(anchor);
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    let state = sandbox.__popoverState();
    check(!!state.el, 'popover: open — singleton element exists');
    check(state.anchor === anchor, 'popover: open — anchored to the clicked chip');
    check(
      sandbox.document.body.children.includes(state.el),
      'popover: hosted on document.body (survives grid-subtree wipes by construction)'
    );
    check(state.el.classes.includes('ch-result-popover'), 'popover: carries the token-block class ch-result-popover');
    const lines = state.el.querySelectorAll('.ch-result-popover-line');
    check(lines.length === 2, `popover: one line per detail entry (got ${lines.length})`);
    check(
      lines[0].textContent ===
        'Potassium 6.2 mmol/L ↑ (3.5–5.3) · 12 Jun · rule: Critical high potassium (red ≥6.5) · was 4.1, 03 May',
      `popover: line text is formatDetailLine output via textContent (got "${lines[0].textContent}")`
    );
    check(
      lines[0]._innerHTML === null && lines[1]._innerHTML === null,
      'popover: lines were built with textContent, never innerHTML (fake-DOM innerHTML slot untouched)'
    );
    check(
      lines[0].classes.includes('ch-result-popover-line-above'),
      'popover: above-flag line carries its severity class'
    );

    // ---- toggle: same anchor closes; different anchor swaps (still singleton) ----
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    state = sandbox.__popoverState();
    check(!state.el && !state.anchor, 'popover: clicking the same anchor again closes it (toggle)');
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    const anchor2 = new El('span', { class: 'ch-chip ch-chip-amber' });
    gridRoot.appendChild(anchor2);
    sandbox.toggleResultDetailPopover(anchor2, rowId, false);
    state = sandbox.__popoverState();
    check(state.anchor === anchor2, 'popover: clicking a different chip swaps the singleton to the new anchor');
    check(
      sandbox.document.body.children.filter((c) => c.classes.includes('ch-result-popover')).length === 1,
      'popover: only ever ONE popover element on the body (singleton)'
    );
    sandbox.closeResultDetailPopover();
    check(!sandbox.__popoverState().el, 'popover: closeResultDetailPopover clears element + anchor state');

    // ---- empty detail: popover still opens, with the explicit empty message ----
    sandbox._queueResultCache.set(rowId, { sev: redSev, ts: Date.now() }); // no .detail
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    state = sandbox.__popoverState();
    check(
      state.el.querySelectorAll('.ch-result-popover-empty').length === 1 &&
        state.el.querySelectorAll('.ch-result-popover-line').length === 0,
      'popover: no cached detail → explicit "No detail available." message, no fabricated lines'
    );
    sandbox.closeResultDetailPopover();

    // ---- error variant: fixed explanation, never a numeric detail array ----
    // Even a (hypothetical) stale detail array on an error entry must not render —
    // the live entry.error state wins.
    sandbox._queueResultCache.set(rowId, { sev: null, error: true, ts: Date.now(), detail: detailArr });
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    state = sandbox.__popoverState();
    const errLines = state.el.querySelectorAll('.ch-result-popover-error');
    check(errLines.length === 1, 'error popover: renders the single explanation line');
    check(
      errLines[0].textContent === sandbox.RESULT_ERROR_POPOVER_TEXT,
      'error popover: explanation text assigned via textContent'
    );
    check(
      /retries automatically/.test(errLines[0].textContent),
      'error popover: tells the GP it retries automatically'
    );
    check(
      state.el.querySelectorAll('.ch-result-popover-line-above').length === 0 && !/6\.2/.test(state.el.textContent),
      'error popover: NEVER shows the stale numeric detail lines (live entry.error wins)'
    );
    sandbox.closeResultDetailPopover();

    // ---- inject-time error flag alone (no live cache entry) also gets the error popover ----
    sandbox._queueResultCache.delete(rowId);
    sandbox.toggleResultDetailPopover(anchor, rowId, true);
    state = sandbox.__popoverState();
    check(
      state.el.querySelectorAll('.ch-result-popover-error').length === 1,
      'error popover: inject-time isError flag alone (cache entry gone) still shows the explanation'
    );
    sandbox.closeResultDetailPopover();

    // ---- anchor death: refreshQueueChips' guard closes a popover whose anchor was wiped ----
    sandbox._queueResultCache.set(rowId, { sev: redSev, ts: Date.now(), detail: detailArr });
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    check(!!sandbox.__popoverState().el, 'anchor death: popover open before the wipe');
    anchor.remove(); // Vue re-render strips the injected chip node
    check(!sandbox.document.contains(anchor), 'anchor death: anchor no longer in the document');
    // The exact guard refreshQueueChips runs each wipe cycle (source-pinned in
    // test-result-triage-queue.js Layer 7; executed here against the live state):
    vm.runInContext(
      'if (_resultDetailPopoverAnchor && !document.contains(_resultDetailPopoverAnchor)) { closeResultDetailPopover(); }',
      sandbox
    );
    check(!sandbox.__popoverState().el, 'anchor death: the refreshQueueChips guard closes the orphaned popover');

    // ---- dataset stamp: injectResultChip records the taskUuid on the chip host ----
    freshCaches();
    const rowId2 = '77777777-7777-4777-8777-777777777777';
    const pair2 = buildPreviewRowPair({ rowIndex: 0, rowId: rowId2, dob: '01 Jan 1980 (46y)' });
    const gridRoot2 = new El('div', {});
    gridRoot2.appendChild(pair2.master);
    gridRoot2.appendChild(pair2.detail);
    sandbox.document = makeDocument(gridRoot2);
    sandbox.queueObservedContainer = gridRoot2;
    sandbox.injectResultChip(0, redSev, rowId2, false);
    const injectedSpan = pair2.wrap.querySelector('.ch-q-result');
    check(!injectedSpan, 'dataset stamp: result chip is not injected');

    // ---- trend arrow rules on the chip label (item 2.6) ----
    const arrowSev = (dir, level) => ({
      level,
      urgentCount: level === 'red' ? 1 : 0,
      abnormalCount: 1,
      top: {
        name: 'Potassium',
        value: '6.8',
        unit: 'mmol/L',
        ruleLabel: null,
        prior: dir ? { value: 4.1, date: '2026-05-03', dir } : null,
      },
      misprioritised: false,
      unmatched: false,
    });
    const chipsFor = (sev) => sandbox.selectResultChips(sev);
    check(
      chipsFor(arrowSev('up', 'red'))[0].vars.name === 'Potassium ↑',
      'trend arrow: red chip with an "up" prior gains ↑ on its label var'
    );
    check(chipsFor(arrowSev('down', 'red'))[0].vars.name === 'Potassium ↓', 'trend arrow: "down" prior gains ↓');
    check(chipsFor(arrowSev('same', 'red'))[0].vars.name === 'Potassium', 'trend arrow: "same" prior gets NO glyph');
    check(
      chipsFor(arrowSev(null, 'red'))[0].vars.name === 'Potassium',
      'trend arrow: no prior gets NO glyph (pre-2.6 sev shapes unaffected)'
    );
    // The green/none level renders no severity chip at all, so no arrow can leak
    // onto a calm row via this path (arrow is red/amber-only by construction).
    check(
      chipsFor({ ...noneSev, top: { name: 'X', prior: { value: 1, date: null, dir: 'up' } } }).length === 0,
      'trend arrow: a none-level report renders no severity chip, so no arrow (red/amber only)'
    );
  }

  console.log(
    '\nLayer 16: detail-page verdict banner (item 2.4) — render, error, nothing, stale-task replace, pref gate, textContent discipline'
  );
  {
    freshCaches();
    const hostCard = new El('div', { class: 'm-card-v2' });
    sandbox.document = makeDocument(hostCard);
    sandbox.findCardByTitle = (title) => (title === 'Task Details' ? hostCard : null);

    const taskA = '11111111-1111-4111-8111-111111111111';
    const taskB = '22222222-2222-4222-8222-222222222222';
    const taskC = '33333333-3333-4333-8333-333333333333';
    const taskD = '44444444-4444-4444-8444-444444444444';
    const taskE = '55555555-5555-4555-8555-555555555555';
    const ctxFor = (taskUuid) => ({ apiBase: 'https://x', taskUuid, taskTypeSlug: 'investigation_result' });
    const setCtx = (taskUuid) => {
      sandbox.window.SentinelApiClient = { detectMedicusContext: () => ctxFor(taskUuid) };
    };

    // ---- detailVerdictState: pure decision function ----
    const now = 1_800_000_000_000;
    check(sandbox.detailVerdictState(undefined, now) === 'compute', 'state: no entry -> compute');
    check(
      sandbox.detailVerdictState({ sev: undefined }, now) === 'compute',
      'state: never-evaluated (sev undefined) -> compute'
    );
    check(
      sandbox.detailVerdictState({ sev: { level: 'red' }, ts: now - 1000 }, now) === 'render',
      'state: fresh non-null sev -> render'
    );
    check(
      sandbox.detailVerdictState({ sev: { level: 'red' }, ts: now - 6 * 60 * 1000 }, now) === 'compute',
      'state: sev aged past _RESULT_CACHE_TTL -> compute (stale, not render)'
    );
    check(
      sandbox.detailVerdictState({ sev: null, ts: now - 1000 }, now) === 'nothing',
      'state: fresh definitive null -> nothing'
    );
    check(
      sandbox.detailVerdictState({ sev: null, error: true, ts: now - 1000 }, now) === 'error',
      'state: fresh error entry -> error'
    );
    check(
      sandbox.detailVerdictState({ sev: null, error: true, ts: now - 61 * 1000 }, now) === 'compute',
      'state: error entry aged past the SHORT _RESULT_ERROR_TTL -> compute (retry), not stuck on error'
    );

    // ---- buildDetailVerdictHeadline: reuses sev fields, never re-derives severity ----
    check(
      sandbox.buildDetailVerdictHeadline({ level: 'red', urgentCount: 2, abnormalCount: 0 }) === '2 urgent',
      'headline: red multi-urgent'
    );
    check(
      sandbox.buildDetailVerdictHeadline({ level: 'red', urgentCount: 1, abnormalCount: 0 }) === '1 urgent',
      'headline: red singular urgent (no "1 urgents")'
    );
    check(
      sandbox.buildDetailVerdictHeadline({ level: 'amber', urgentCount: 0, abnormalCount: 4 }) === '4 abnormal',
      'headline: amber abnormal count'
    );
    check(sandbox.buildDetailVerdictHeadline(null) === '', 'headline: null sev -> empty string');

    // ---- render: banner from a FRESH cache entry — headline + capped lines + "+n more" ----
    const detailArr = [
      {
        name: 'Potassium',
        value: 6.2,
        unit: 'mmol/L',
        low: 3.5,
        high: 5.3,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: 'Critical high potassium (red ≥6.5)',
        prior: { value: 4.1, date: '2026-05-03', dir: 'up' },
      },
      {
        name: 'eGFR',
        value: 38,
        unit: 'mL/min',
        low: 90,
        high: null,
        flag: 'below',
        date: '2026-06-12',
        ruleLabel: null,
        prior: null,
      },
      {
        name: 'CRP',
        value: 80,
        unit: 'mg/L',
        low: null,
        high: 10,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: null,
        prior: null,
      },
      {
        name: 'WCC',
        value: 15,
        unit: '10^9/L',
        low: 4,
        high: 11,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: null,
        prior: null,
      },
    ];
    // level 'amber' + abnormalCount (never 'red' + abnormalCount — a real
    // evaluateReportSeverity() only sets level:'red' alongside urgentCount>0,
    // mirroring selectResultChips' own level/count pairing) — this is the
    // plan's own worked example ("2 abnormal: K+ 6.2 up ... eGFR 38 down ...").
    const sevD = {
      level: 'amber',
      urgentCount: 0,
      abnormalCount: 4,
      top: { name: 'Potassium' },
      misprioritised: false,
      unmatched: false,
      detail: detailArr,
    };
    sandbox._queueResultCache.set(taskA, { sev: sevD, ts: Date.now(), detail: detailArr });
    setCtx(taskA);
    sandbox.runDetailVerdict();
    check(
      sandbox.document.querySelectorAll('.ch-detail-verdict').length === 0,
      'banner: a fresh cached severity does not paint a verdict (not in this build)'
    );
    sandbox._queueResultCache.set(taskB, { sev: null, error: true, ts: Date.now() });
    setCtx(taskB);
    sandbox.runDetailVerdict();
    check(
      sandbox.document.querySelectorAll('.ch-detail-verdict').length === 0,
      'error cache: no grey verdict banner is painted'
    );

    // ---- null-sev (nothing gradeable) renders NOTHING, clearing the previous banner ----
    sandbox._queueResultCache.set(taskC, { sev: null, ts: Date.now() }); // definitive, no .error
    setCtx(taskC);
    sandbox.runDetailVerdict();
    check(
      sandbox.document.querySelectorAll('.ch-detail-verdict').length === 0,
      'null-sev: renders NOTHING for a non-gradeable task (admin/med request), and clears the stale banner too'
    );

    // ---- pref gate: detailVerdictBanner:false suppresses even a fresh graded result ----
    sandbox._queueResultCache.set(taskD, { sev: sevD, ts: Date.now(), detail: detailArr });
    sandbox.CONFIG = { prefs: { detailVerdictBanner: false } };
    setCtx(taskD);
    sandbox.runDetailVerdict();
    check(
      sandbox.document.querySelectorAll('.ch-detail-verdict').length === 0,
      'pref off: detailVerdictBanner=false suppresses the banner even with a fresh abnormal result cached'
    );
    sandbox.CONFIG = {}; // restore default (PREF('detailVerdictBanner', true) -> true)

    setCtx(taskD);
    sandbox.runDetailVerdict();
    sandbox._queueResultCache.set(taskE, {
      sev: { level: 'red', urgentCount: 1, abnormalCount: 0, top: { name: 'Potassium' }, detail: [] },
      ts: Date.now(),
    });
    setCtx(taskE);
    sandbox.runDetailVerdict();
    check(
      sandbox.document.querySelectorAll('.ch-detail-verdict').length === 0,
      'switching tasks still paints no verdict banner'
    );

    // ---- textContent discipline (grep-level) — lab/config-derived strings never via innerHTML ----
    const bdvFnMatch = src.match(/const buildDetailVerdictEl = \(taskUuid, sev, isError\) => \{[\s\S]*?\n {2}\};/);
    check(!!bdvFnMatch, 'buildDetailVerdictEl found in content.js for the textContent-discipline check');
    if (bdvFnMatch) {
      check(
        !/\.innerHTML/.test(bdvFnMatch[0]),
        'buildDetailVerdictEl never uses innerHTML (createElement/textContent only)'
      );
      check(
        /\.textContent = formatDetailLine\(entry\)/.test(bdvFnMatch[0]),
        'detail lines are assigned via textContent'
      );
      check(
        /\.textContent = RESULT_ERROR_POPOVER_TEXT/.test(bdvFnMatch[0]),
        'the error line is ALSO assigned via textContent'
      );
    }
  }

  // ============================================================
  // Layer 17 — result-rule guidance actions in the detail popover (item 2.7,
  // TRIAGE-LENS-2026-07-02.md): a detail entry's ruleId resolved against
  // CONFIG.resultRules at RENDER time, action buttons wired to the real
  // (scheme-guarded) executeAction, note actions toggled inline, and rules
  // with no actions (or no ruleId, or an id CONFIG doesn't recognise) render no row.
  // ============================================================
  console.log('\nLayer 17: result-rule guidance actions in the detail popover (item 2.7)');

  {
    freshCaches();
    sandbox.closeResultDetailPopover();
    const rowId = '88888888-8888-4888-8888-888888888888';
    const { master, detail } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    const detailWithActions = [
      {
        name: 'Potassium',
        value: 6.2,
        unit: 'mmol/L',
        low: 3.5,
        high: 5.3,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: 'Critical high potassium (red ≥6.0)',
        ruleId: 'k-critical', // resolves to CONFIG.resultRules below
        prior: null,
      },
      {
        // eGFR: not rule-driven (ruleId null) — must never render an actions row.
        name: 'eGFR',
        value: 38,
        unit: 'mL/min',
        low: 90,
        high: null,
        flag: 'below',
        date: '2026-06-12',
        ruleLabel: null,
        ruleId: null,
        prior: null,
      },
      {
        // ruleId set, but that rule id isn't in CONFIG.resultRules (e.g. deleted since
        // grading ran) — fail-quiet, no row, no throw.
        name: 'Sodium',
        value: 128,
        unit: 'mmol/L',
        low: 133,
        high: 146,
        flag: 'below',
        date: '2026-06-12',
        ruleLabel: 'Low sodium',
        ruleId: 'no-such-rule',
        prior: null,
      },
      {
        // ruleId resolves, but that rule carries NO actions array — no row either.
        name: 'CRP',
        value: 180,
        unit: 'mg/L',
        low: null,
        high: 5,
        flag: 'above',
        date: '2026-06-12',
        ruleLabel: 'High CRP',
        ruleId: 'crp-no-actions',
        prior: null,
      },
    ];

    sandbox.CONFIG = {
      resultRules: [
        {
          id: 'k-critical',
          enabled: true,
          kind: 'threshold',
          label: 'Critical high potassium',
          analyte: { match: ['potassium'] },
          comparator: 'above',
          amber: 5.5,
          red: 6.0,
          actions: [
            { type: 'link', label: 'Hyperkalaemia pathway', url: 'https://example.nhs.uk/hyperk' },
            { type: 'link', label: 'Malicious', url: 'javascript:alert(1)' },
            { type: 'snippet', label: 'Copy safety-net text', text: 'Repeat urgently.' },
            { type: 'note', label: 'Reminder', text: 'Consider same-day ECG if red.' },
          ],
        },
        {
          id: 'crp-no-actions',
          enabled: true,
          kind: 'threshold',
          label: 'High CRP',
          analyte: { match: ['crp'] },
          comparator: 'above',
          amber: 50,
          red: null,
          // no actions array at all
        },
      ],
    };

    sandbox._durableRowMap.set(0, rowId);
    sandbox._queueResultCache.set(rowId, { sev: redSev, ts: Date.now(), detail: detailWithActions });

    const anchor = new El('span', { class: 'ch-chip ch-chip-red' });
    gridRoot.appendChild(anchor);
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    let state = sandbox.__popoverState();
    check(!!state.el, 'popover open with a rule-actions-bearing detail array');

    const actionRows = state.el.querySelectorAll('.ch-result-popover-actions');
    check(actionRows.length === 1, `exactly one actions row rendered (got ${actionRows.length})`);

    const buttons = actionRows[0].querySelectorAll('.ch-result-popover-action');
    check(buttons.length === 4, `one button per action on the fired rule (got ${buttons.length})`);
    check(
      buttons[0].textContent === 'Hyperkalaemia pathway',
      'action button label rendered via textContent (got "' + buttons[0].textContent + '")'
    );
    check(
      buttons[0]._innerHTML === null,
      'action button built with textContent, never innerHTML (fake-DOM innerHTML slot untouched)'
    );
    check(
      buttons[0].classes.includes('ch-result-popover-action-link'),
      'link action button carries its type modifier class'
    );
    check(
      buttons[2].classes.includes('ch-result-popover-action-snippet'),
      'snippet action button carries its type modifier class'
    );
    check(
      buttons[3].classes.includes('ch-result-popover-action-note'),
      'note action button carries its type modifier class'
    );

    // ---- eGFR / Sodium / CRP entries never grow an actions row ----
    const allLines = state.el.querySelectorAll('.ch-result-popover-line');
    check(allLines.length === 4, `four detail lines rendered (got ${allLines.length})`);
    check(
      actionRows.length === 1,
      'rules with no fired ruleId, an unresolvable ruleId, or no actions render NO extra row (only the one true positive)'
    );

    // ---- link action: safe http(s) URL opens via window.open ----
    {
      const opened = [];
      sandbox.window.open = (...args) => opened.push(args);
      buttons[0].click();
      check(
        opened.length === 1 && opened[0][0] === 'https://example.nhs.uk/hyperk',
        'clicking a safe link action button calls window.open with its URL (via the real executeAction)'
      );
      delete sandbox.window.open;
    }

    // ---- link action: javascript: URL is blocked by executeAction's isSafeActionUrl guard ----
    {
      const opened = [];
      sandbox.window.open = (...args) => opened.push(args);
      buttons[1].click();
      check(
        opened.length === 0,
        'clicking a javascript: link action button never calls window.open (executeAction scheme guard holds here too)'
      );
      delete sandbox.window.open;
    }

    // ---- note action: toggles an inline text block via textContent, no navigation away ----
    const noteBtn = buttons[3];
    const noteBlocksBefore = actionRows[0].querySelectorAll('.ch-result-popover-action-notebody');
    check(noteBlocksBefore.length === 1, 'note text block exists (hidden) before click');
    check(noteBlocksBefore[0].style.display === 'none', 'note text block starts hidden');
    noteBtn.click();
    check(noteBlocksBefore[0].style.display === 'block', 'clicking the note button reveals its text inline');
    check(noteBlocksBefore[0].textContent === 'Consider same-day ECG if red.', 'note text rendered via textContent');
    check(
      !!state.el && sandbox.document.body.children.includes(state.el),
      'note click does NOT replace/close the whole popover — the other detail lines are still there'
    );
    noteBtn.click();
    check(noteBlocksBefore[0].style.display === 'none', 'clicking the note button again hides it (toggle)');

    sandbox.closeResultDetailPopover();

    // ---- CONFIG.resultRules edited between fetch and popover open: actions reflect
    //      the LIVE config, not anything cached at fetch time (the plan's explicit
    //      "lookup-at-render, not cache-invalidation" design). ----
    sandbox.CONFIG.resultRules[0].actions = [{ type: 'note', label: 'Updated guidance', text: 'New text.' }];
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    state = sandbox.__popoverState();
    const freshButtons = state.el.querySelectorAll('.ch-result-popover-action');
    check(
      freshButtons.length === 1 && freshButtons[0].textContent === 'Updated guidance',
      'editing CONFIG.resultRules[].actions changes what the NEXT popover open renders — no cache to invalidate'
    );
    sandbox.closeResultDetailPopover();

    // ---- empty CONFIG (no resultRules at all) never throws, renders no actions row ----
    sandbox.CONFIG = {};
    sandbox.toggleResultDetailPopover(anchor, rowId, false);
    state = sandbox.__popoverState();
    check(
      state.el.querySelectorAll('.ch-result-popover-actions').length === 0,
      'CONFIG with no resultRules array → no actions row, no throw'
    );
    sandbox.closeResultDetailPopover();
  }

  // ============================================================
  // Layer 19 — negation/past-tense demotion (item 3.4, TRIAGE-LENS-2026-07-02.md)
  // ============================================================
  console.log('\nLayer 19: negation/past-tense demotion — display-only, escalate-only, never suppressed');

  {
    // ---- ranking: kind first, then unqualified before qualified WITHIN a kind ----
    freshCaches();
    const ruleRedCardiac = mkRule('r-red-cardiac', 'red', 'Cardiac flag', ['crushing']);
    const previewText = 'No fever today. Crushing chest sensation now. Waterworks fine.';
    const ranked = sandbox.rankRuleMatches([ruleRed, ruleRedCardiac, ruleAmber], previewText);
    check(
      ranked.map((r) => r.id).join(',') === 'r-red-cardiac,r-red,r-amber',
      `ranking: unqualified red first, negated red still above unqualified amber (kind wins), got ${ranked.map((r) => r.id).join(',')}`
    );
    check(!ranked[0]._qualifier, 'unqualified red rule (Cardiac flag) carries no _qualifier');
    check(
      ranked[1]._qualifier === 'negated',
      `negated red rule (Sepsis flag) is marked _qualifier="negated" (got ${ranked[1]._qualifier})`
    );
    check(!ranked[2]._qualifier, 'unqualified amber rule (UTI query) carries no _qualifier');
  }

  {
    // ---- decorateOneRow: an all-demoted row STILL shows its chip (never suppressed) ----
    freshCaches();
    sandbox.matchRules = () => [ruleRed];
    const rowId = 'f0000000-0000-4000-8000-000000000001';
    const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
    wrap.children[0].textContent = 'Request: No fever reported today, patient otherwise well.';
    const gridRoot = new El('div', {});
    gridRoot.appendChild(master);
    gridRoot.appendChild(detail);
    sandbox.document = makeDocument(gridRoot);
    sandbox.queueObservedContainer = gridRoot;

    sandbox.decorateOneRow(master);
    const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
    check(ruleChips.length === 1, `all-demoted single-rule row still renders its chip, got ${ruleChips.length}`);
    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }

  {
    // ---- past-tense demotion + the "+N" list-view qualifier badge ----
    freshCaches();
    const ruleUti = mkRule('r-amber-uti', 'amber', 'UTI query', ['UTI']);
    const previewText = 'Denies fever this week. Had a UTI last year, no issues since.';
    const ranked = sandbox.rankRuleMatches([ruleUti, ruleRed], previewText);
    check(
      ranked[0].id === 'r-red' && ranked[0]._qualifier === 'negated',
      `top rule is the negated red match (got id=${ranked[0].id}, qualifier=${ranked[0]._qualifier})`
    );
    check(
      ranked[1].id === 'r-amber-uti' && ranked[1]._qualifier === 'past',
      `second rule is the past-demoted amber match (got id=${ranked[1].id}, qualifier=${ranked[1]._qualifier})`
    );

    sandbox.document = makeDocument(new El('div', {}));
    const anchor = new El('span');
    sandbox.showRuleMatchMenu(anchor, ranked, previewText, true);
    const menu = sandbox.document.querySelector('.ch-rule-menu');
    const badges = menu.querySelectorAll('.ch-rule-menu-list-qualifier');
    check(badges.length === 2, `both demoted rules carry a list-view qualifier badge, got ${badges.length}`);
    const badgeTexts = badges
      .map((b) => b.textContent)
      .sort()
      .join(',');
    check(
      badgeTexts === 'negated?,past?',
      `badges read RULE_QUALIFIER_LABEL's "negated?" and "past?" respectively (got "${badgeTexts}")`
    );
    check(
      badges[0].textContent === sandbox.RULE_QUALIFIER_LABEL.negated ||
        badges[0].textContent === sandbox.RULE_QUALIFIER_LABEL.past,
      'badge text comes from the shared RULE_QUALIFIER_LABEL map, not a separately hand-typed string'
    );
    sandbox.closeActionMenu();
  }

  {
    // ---- RULE_QUALIFIER_EVIDENCE_CAP: on a row matching MORE than 4 rules,
    //      only the top 4 (by kind, tie-broken by original order) get evidence
    //      computed — the rest are left unqualified for RANKING purposes only.
    //      Cheapness safeguard, never a suppression: all 5 still rank/render. ----
    freshCaches();
    const capRules = ['headache', 'cough', 'rash', 'fatigue', 'dizziness'].map((w, i) =>
      mkRule(`r-red-cap-${i}`, 'red', `Flag ${i}`, [w])
    );
    const previewText = 'No headache, no cough, no rash, no fatigue, no dizziness today.';
    const ranked = sandbox.rankRuleMatches(capRules, previewText);
    check(ranked.length === 5, 'all 5 matched rules still rank (the cap affects evidence COST only, never suppresses)');
    const evaluatedNegated = ranked.filter((r) => r._qualifier === 'negated').length;
    check(
      evaluatedNegated === 4,
      `only the top 4 (by kind, tie-broken by original matchRules order) get evidence computed — got ${evaluatedNegated} marked negated`
    );
    const beyondCap = ranked.find((r) => r.id === 'r-red-cap-4');
    check(
      !!beyondCap && beyondCap._qualifier === null,
      'the 5th rule (beyond the cap) is left unqualified for ranking, even though it WOULD be negated if evaluated'
    );
  }

  // ============================================================
  // Layer 21 — item 3.5 (TRIAGE-LENS-2026-07-02.md): request-rule `require` gate
  // on the queue. decorateOneRow parses this row's OWN age from its DOB cell
  // (the same parse the child/elder system chips already use) and applies
  // window.TriageLensMatch.ruleRequireMet as an ADDITIONAL gate on top of the
  // (stubbed here) text-matched rules — a rule whose require clause the queue
  // cannot confirm is excluded from the rendered rule chips, but never
  // suppresses any OTHER matched rule. The queue has NO meds/problems/sex data,
  // so a require:{medsAny|problemsAny|sex} clause always fails closed there.
  // ============================================================
  console.log('\nLayer 21: item 3.5 — request-rule require gate on the queue (age fires, meds fails closed)');

  {
    const ageGatedRule = RM.compileRule({
      id: 'r-age-child',
      label: 'UTI (child)',
      kind: 'red',
      enabled: true,
      regex: false,
      patterns: ['uti'],
      fields: ['request'],
      pages: ['queue'],
      builtin: true,
      require: { ageMax: 15 },
    });
    const medsGatedRule = RM.compileRule({
      id: 'r-meds-mtx',
      label: 'Infection (methotrexate)',
      kind: 'red',
      enabled: true,
      regex: false,
      patterns: ['infection'],
      fields: ['request'],
      pages: ['queue'],
      builtin: true,
      require: { medsAny: ['methotrexate'] },
    });
    const ungatedRule = RM.compileRule({
      id: 'r-plain',
      label: 'Plain UTI',
      kind: 'amber',
      enabled: true,
      regex: false,
      patterns: ['uti'],
      fields: ['request'],
      pages: ['queue'],
      builtin: true,
    });

    // ---- age-gated rule FIRES on the queue: this row's own DOB cell parses
    //      to age 8, which satisfies require:{ageMax:15} — and the ungated
    //      rule matched alongside it is entirely unaffected (base rule intact). ----
    {
      freshCaches();
      sandbox.matchRules = () => [ageGatedRule, ungatedRule];
      const rowId = 'f0000000-0000-4000-8000-000000000001';
      const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 2018 (8y)' });
      const gridRoot = new El('div', {});
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
      sandbox.document = makeDocument(gridRoot);
      sandbox.queueObservedContainer = gridRoot;

      sandbox.decorateOneRow(master);
      const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
      check(ruleChips.length === 2, `age-gated rule fires beside the ungated rule, got ${ruleChips.length}`);
    }

    // ---- meds-gated rule FAILS CLOSED on the queue: no meds data is available
    //      on this surface, so require:{medsAny:[...]} can never be confirmed —
    //      the rule is excluded, never guessed either way. ----
    {
      freshCaches();
      sandbox.matchRules = () => [medsGatedRule];
      const rowId = 'f0000000-0000-4000-8000-000000000002';
      const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 1980 (46y)' });
      const gridRoot = new El('div', {});
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
      sandbox.document = makeDocument(gridRoot);
      sandbox.queueObservedContainer = gridRoot;

      sandbox.decorateOneRow(master);
      const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
      check(
        ruleChips.length === 0,
        `meds-gated rule fails closed on the queue (no meds data reachable there) — 0 rule-match chips, got ${ruleChips.length}`
      );
    }

    // ---- both an age-gated and a meds-gated rule matched the same row: the
    //      age-gated one still fires (its own gate is satisfiable here), the
    //      meds-gated one is excluded — neither affects the other. ----
    {
      freshCaches();
      sandbox.matchRules = () => [ageGatedRule, medsGatedRule];
      const rowId = 'f0000000-0000-4000-8000-000000000003';
      const { master, detail, wrap } = buildPreviewRowPair({ rowIndex: 0, rowId, dob: '01 Jan 2018 (8y)' });
      const gridRoot = new El('div', {});
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
      sandbox.document = makeDocument(gridRoot);
      sandbox.queueObservedContainer = gridRoot;

      sandbox.decorateOneRow(master);
      const ruleChips = wrap.querySelectorAll('.ch-q-rule-chip');
      check(ruleChips.length === 1, `mixed age/meds row paints the age-gated chip only, got ${ruleChips.length}`);
    }

    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }

  // ============================================================
  // Layer 22 — item 4.6 (TRIAGE-LENS-2026-07-02.md): keyboard triage.
  // j/k cursor movement + clamping, Enter opens the cursor row's link,
  // n reuses jumpToAlertRow/nextAlertRowIndex and parks the cursor there,
  // the handler ignores keys typed into a form field, and the cursor class
  // is wiped+reapplied on the churn cycle (never leaks onto a recycled row).
  // ============================================================
  console.log('\nLayer 22: keyboard triage — j/k cursor, clamping, Enter open-link, n jump, typing-guard, churn');

  {
    const kbdEvent = (key, target, extra) =>
      Object.assign(
        {
          key,
          target: target || { tagName: 'BODY' },
          preventDefault() {},
          metaKey: false,
          ctrlKey: false,
          altKey: false,
        },
        extra || {}
      );

    // ---- j/k move the cursor over rows, clamping at both ends ----
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIds3 = [
      'b0000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000002',
      'b0000000-0000-4000-8000-000000000003',
    ];
    const rows3 = rowIds3.map((rowId, i) => buildPreviewRowPair({ rowIndex: i, rowId, dob: '01 Jan 1980 (46y)' }));
    const gridRootK = new El('div', {});
    rows3.forEach(({ master, detail }) => {
      gridRootK.appendChild(master);
      gridRootK.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRootK);
    sandbox.queueObservedContainer = gridRootK;

    sandbox.onQueueKeydown(kbdEvent('j'));
    check(rows3[0].master.classes.includes('ch-kbd-cursor'), 'j from no cursor: lands on the FIRST row (row-index 0)');
    check(sandbox.__getKbdCursor() === 0, 'j from no cursor: _kbdCursorRowIndex is 0');

    sandbox.onQueueKeydown(kbdEvent('j'));
    check(!rows3[0].master.classes.includes('ch-kbd-cursor'), 'j: previous cursor row loses the class (single cursor)');
    check(rows3[1].master.classes.includes('ch-kbd-cursor'), 'j: cursor now on row-index 1');
    check(rows3[1].detail.classes.includes('ch-kbd-cursor'), 'j: preview/detail row ALSO gets the cursor class');

    sandbox.onQueueKeydown(kbdEvent('ArrowDown'));
    check(rows3[2].master.classes.includes('ch-kbd-cursor'), 'ArrowDown: cursor now on row-index 2 (last row)');

    sandbox.onQueueKeydown(kbdEvent('j'));
    check(
      rows3[2].master.classes.includes('ch-kbd-cursor') && sandbox.__getKbdCursor() === 2,
      'j at the last row: CLAMPS (stays at row-index 2), does not wrap to row 0'
    );

    sandbox.onQueueKeydown(kbdEvent('k'));
    sandbox.onQueueKeydown(kbdEvent('k'));
    check(rows3[0].master.classes.includes('ch-kbd-cursor'), 'k k: cursor walked back down to row-index 0');
    sandbox.onQueueKeydown(kbdEvent('ArrowUp'));
    check(
      rows3[0].master.classes.includes('ch-kbd-cursor') && sandbox.__getKbdCursor() === 0,
      'k at the first row: CLAMPS (stays at row-index 0), does not wrap to the last row'
    );

    // ---- moveKbdCursor (pure) — direct clamp/empty-list assertions ----
    check(sandbox.moveKbdCursor(null, [], 1) === null, 'moveKbdCursor: empty row list -> null');
    check(sandbox.moveKbdCursor(null, [5, 7, 9], 1) === 5, 'moveKbdCursor: no cursor yet, direction down -> first row');
    check(sandbox.moveKbdCursor(null, [5, 7, 9], -1) === 9, 'moveKbdCursor: no cursor yet, direction up -> last row');
    check(sandbox.moveKbdCursor(9, [5, 7, 9], 1) === 9, 'moveKbdCursor: clamps at the last row going down');
    check(sandbox.moveKbdCursor(5, [5, 7, 9], -1) === 5, 'moveKbdCursor: clamps at the first row going up');
    check(
      sandbox.moveKbdCursor(999, [5, 7, 9], 1) === 5,
      'moveKbdCursor: a cursor row no longer in the list re-anchors to the first row (direction down)'
    );

    // ---- Enter activates the cursor row: clicks its open-link ----
    // Sub-case A: no anchor in the patientName cell -> falls back to clicking
    // the cell itself (the documented fallback host elsewhere in this file).
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIdEnterA = 'b0000000-0000-4000-8000-000000000004';
    const rowEnterA = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdEnterA, dob: '01 Jan 1980 (46y)' });
    const gridRootEnterA = new El('div', {});
    gridRootEnterA.appendChild(rowEnterA.master);
    gridRootEnterA.appendChild(rowEnterA.detail);
    sandbox.document = makeDocument(gridRootEnterA);
    sandbox.queueObservedContainer = gridRootEnterA;
    const nameCellA = rowEnterA.master.querySelector('[col-id="patientName"]');
    let cellClicked = false;
    nameCellA.addEventListener('click', () => {
      cellClicked = true;
    });

    sandbox.onQueueKeydown(kbdEvent('j')); // put the cursor on row 0
    sandbox.onQueueKeydown(kbdEvent('Enter'));
    check(cellClicked, 'Enter (no anchor present): clicks the patientName CELL itself');

    // Sub-case B: an anchor IS present inside the patientName cell -> Enter
    // clicks the anchor, not the cell.
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIdEnterB = 'b0000000-0000-4000-8000-000000000005';
    const rowEnterB = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdEnterB, dob: '01 Jan 1980 (46y)' });
    const gridRootEnterB = new El('div', {});
    gridRootEnterB.appendChild(rowEnterB.master);
    gridRootEnterB.appendChild(rowEnterB.detail);
    sandbox.document = makeDocument(gridRootEnterB);
    sandbox.queueObservedContainer = gridRootEnterB;
    const nameCellB = rowEnterB.master.querySelector('[col-id="patientName"]');
    const anchorB = new El('a', { href: '#' });
    nameCellB.appendChild(anchorB);
    let anchorClicked = false;
    let cellBClicked = false;
    anchorB.addEventListener('click', () => {
      anchorClicked = true;
    });
    nameCellB.addEventListener('click', () => {
      cellBClicked = true;
    });

    sandbox.onQueueKeydown(kbdEvent('j'));
    sandbox.onQueueKeydown(kbdEvent('Enter'));
    check(anchorClicked, 'Enter (anchor present): clicks the ANCHOR inside the patientName cell');
    check(
      !cellBClicked,
      "Enter (anchor present): does NOT also click the cell itself (anchor wins, doesn't bubble here)"
    );

    // findQueueRowOpenTarget directly — no cell at all -> null, not a throw.
    const rowNoCell = new El('div', { class: 'ag-row', 'row-index': '0' });
    check(sandbox.findQueueRowOpenTarget(rowNoCell) === null, 'findQueueRowOpenTarget: no patientName cell -> null');

    // ---- n reuses jumpToAlertRow/nextAlertRowIndex and parks the cursor ----
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIdRedN = 'b0000000-0000-4000-8000-000000000006';
    const rowIdAmberN = 'b0000000-0000-4000-8000-000000000007';
    const rowRedN = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRedN, dob: '01 Jan 1980 (46y)' });
    const rowAmberN = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdAmberN, dob: '01 Jan 1980 (46y)' });
    const gridRootN = new El('div', {});
    [rowRedN, rowAmberN].forEach(({ master, detail }) => {
      gridRootN.appendChild(master);
      gridRootN.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRootN);
    sandbox.queueObservedContainer = gridRootN;
    sandbox._durableRowMap.set(0, rowIdRedN);
    sandbox._durableRowMap.set(1, rowIdAmberN);
    sandbox._queueResultCache.set(rowIdRedN, { sev: redSev, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdAmberN, { sev: amberSev, ts: Date.now() });
    sandbox.reapplyQueueRowTint();

    sandbox.onQueueKeydown(kbdEvent('n'));
    check(sandbox.__getKbdCursor() == null, 'n: does not jump, because result rows are not tinted');
    check(!rowRedN.master.classes.includes('ch-kbd-cursor'), 'n: no keyboard cursor is parked on an untinted row');
    check(!rowRedN.master.classes.includes('ch-q-status-flash'), 'n: an untinted cached-red row is not flashed');

    // ---- handler ignores keys when focus is in a form field ----
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIdTyping = 'b0000000-0000-4000-8000-000000000008';
    const rowTyping = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdTyping, dob: '01 Jan 1980 (46y)' });
    const gridRootTyping = new El('div', {});
    gridRootTyping.appendChild(rowTyping.master);
    gridRootTyping.appendChild(rowTyping.detail);
    sandbox.document = makeDocument(gridRootTyping);
    sandbox.queueObservedContainer = gridRootTyping;

    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      sandbox.onQueueKeydown(kbdEvent('j', target));
    }
    check(
      sandbox.__getKbdCursor() === null && !rowTyping.master.classes.includes('ch-kbd-cursor'),
      'onQueueKeydown: "j" typed into an input/textarea/select/contenteditable never moves the cursor'
    );
    check(
      sandbox.isQueueKeydownTypingTarget({ tagName: 'INPUT' }) === true &&
        sandbox.isQueueKeydownTypingTarget({ tagName: 'DIV' }) === false &&
        sandbox.isQueueKeydownTypingTarget(null) === false,
      'isQueueKeydownTypingTarget: input/textarea/select/contentEditable true, plain div/null false'
    );

    // Off the queue page (pageType !== 'queue') the handler is a no-op too.
    sandbox.pageType = () => 'detail';
    sandbox.onQueueKeydown(kbdEvent('j'));
    check(sandbox.__getKbdCursor() === null, 'onQueueKeydown: off the queue page, "j" is a no-op');

    // Pref off -> handler is a no-op even on the queue page.
    sandbox.pageType = () => 'queue';
    sandbox.CONFIG = { prefs: { queueKeyboardNav: false } };
    sandbox.onQueueKeydown(kbdEvent('j'));
    check(sandbox.__getKbdCursor() === null, 'onQueueKeydown: prefs.queueKeyboardNav=false -> "j" is a no-op');
    sandbox.CONFIG = {};

    // ---- cursor class wiped + reapplied on the churn cycle; never leaks
    //      onto a recycled row-index ----
    freshCaches();
    sandbox.pageType = () => 'queue';
    const rowIdChurnK = 'b0000000-0000-4000-8000-000000000009';
    const rowChurnK = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdChurnK, dob: '01 Jan 1980 (46y)' });
    const gridRootChurnK = new El('div', {});
    gridRootChurnK.appendChild(rowChurnK.master);
    gridRootChurnK.appendChild(rowChurnK.detail);
    sandbox.document = makeDocument(gridRootChurnK);
    sandbox.queueObservedContainer = gridRootChurnK;

    sandbox.onQueueKeydown(kbdEvent('j')); // cursor -> row-index 0
    check(rowChurnK.master.classes.includes('ch-kbd-cursor'), 'churn setup: cursor present before the churn cycle');

    sandbox.clearQueueKbdCursor();
    check(
      !rowChurnK.master.classes.includes('ch-kbd-cursor') && !rowChurnK.detail.classes.includes('ch-kbd-cursor'),
      'clearQueueKbdCursor: cursor class removed on the wipe half of the refresh cycle'
    );
    sandbox.applyQueueKbdCursor();
    check(
      rowChurnK.master.classes.includes('ch-kbd-cursor'),
      'applyQueueKbdCursor: cursor restored on the SAME row-index after the wipe (churn cycle survives)'
    );

    // AG-Grid REUSES the same DOM node for a given row-index slot across
    // churn (that's what "virtualised" means — same node object, different
    // backing task) — same reasoning Layer 8's tint "recycled row-index"
    // scenario relies on. For the cursor, which is row-index-keyed (not
    // taskUuid-keyed), that reuse is transparent: the SAME node just keeps
    // its cursor class across a wipe/reapply cycle, already covered above.
    // The other real churn shape is the grid being torn down and rebuilt
    // with a DIFFERENT row-index set entirely (e.g. the queue re-sorted and
    // row-index 0 no longer exists in the new render) — applyQueueKbdCursor
    // must be a safe no-op then, not throw and not tag the wrong row.
    const rowOtherIndex = buildPreviewRowPair({
      rowIndex: 5,
      rowId: 'b0000000-0000-4000-8000-00000000000a',
      dob: '01 Jan 1980 (46y)',
    });
    const gridRootRebuilt = new El('div', {});
    gridRootRebuilt.appendChild(rowOtherIndex.master);
    gridRootRebuilt.appendChild(rowOtherIndex.detail);
    sandbox.document = makeDocument(gridRootRebuilt);
    sandbox.queueObservedContainer = gridRootRebuilt;

    sandbox.clearQueueKbdCursor(); // no-op against the new DOM (nothing carries the class there)
    sandbox.applyQueueKbdCursor(); // _kbdCursorRowIndex is still 0 — no row-index 0 in this DOM
    check(
      !rowOtherIndex.master.classes.includes('ch-kbd-cursor'),
      'grid rebuilt with a different row-index set: applyQueueKbdCursor does not mis-tag an unrelated row'
    );

    sandbox.pageType = () => 'detail'; // restore the file's default for any later scenarios
  }

  // ============================================================
  // Layer 23 — item 4.7 (TRIAGE-LENS-2026-07-02.md, SAFETY-SENSITIVE):
  // seen-session row dimming. A seen clear/unassessed row dims; a seen
  // red/amber row NEVER dims; a seen row that later re-grades red/amber
  // auto-loses the dim on reapply; pref-off means no dim at all; the dim
  // survives a churn cycle only for rows still clear.
  // ============================================================
  console.log(
    '\nLayer 23: seen-session row dimming — clear dims, red/amber NEVER dims, auto-undim on escalation, pref gate, churn'
  );

  {
    // ---- a seen CLEAR row dims ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdClear = 'c0000000-0000-4000-8000-000000000001';
    const rowClear = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdClear, dob: '01 Jan 1980 (46y)' });
    const gridRootClear = new El('div', {});
    gridRootClear.appendChild(rowClear.master);
    gridRootClear.appendChild(rowClear.detail);
    sandbox.document = makeDocument(gridRootClear);
    sandbox.queueObservedContainer = gridRootClear;
    sandbox._durableRowMap.set(0, rowIdClear);
    sandbox._queueResultCache.set(rowIdClear, { sev: noneSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdClear);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(rowClear.master.classes.includes('ch-row-seen'), 'a seen, cached-clear row gets ch-row-seen');
    check(rowClear.detail.classes.includes('ch-row-seen'), 'a seen, cached-clear preview row ALSO gets ch-row-seen');

    // ---- a seen row NOT yet in _seenTasks does not dim ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdUnseen = 'c0000000-0000-4000-8000-000000000002';
    const rowUnseen = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdUnseen, dob: '01 Jan 1980 (46y)' });
    const gridRootUnseen = new El('div', {});
    gridRootUnseen.appendChild(rowUnseen.master);
    gridRootUnseen.appendChild(rowUnseen.detail);
    sandbox.document = makeDocument(gridRootUnseen);
    sandbox.queueObservedContainer = gridRootUnseen;
    sandbox._durableRowMap.set(0, rowIdUnseen);
    sandbox._queueResultCache.set(rowIdUnseen, { sev: noneSev, ts: Date.now() });
    // deliberately NOT added to _seenTasks

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(!rowUnseen.master.classes.includes('ch-row-seen'), 'a cached-clear row NOT in _seenTasks never dims');

    // ---- HARD SAFETY GATE: a seen RED row NEVER dims ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdRedSeen = 'c0000000-0000-4000-8000-000000000003';
    const rowRedSeen = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRedSeen, dob: '01 Jan 1980 (46y)' });
    const gridRootRedSeen = new El('div', {});
    gridRootRedSeen.appendChild(rowRedSeen.master);
    gridRootRedSeen.appendChild(rowRedSeen.detail);
    sandbox.document = makeDocument(gridRootRedSeen);
    sandbox.queueObservedContainer = gridRootRedSeen;
    sandbox._durableRowMap.set(0, rowIdRedSeen);
    sandbox._queueResultCache.set(rowIdRedSeen, { sev: redSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdRedSeen);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(!rowRedSeen.master.classes.includes('ch-row-sev-red'), 'red-cached row: result tint is not applied');
    check(
      !rowRedSeen.master.classes.includes('ch-row-seen'),
      'SAFETY: a seen RED row is NEVER dimmed, even though its taskUuid is in _seenTasks'
    );

    // ---- HARD SAFETY GATE (cross-pref): row-tint OFF + seen-dim ON, a seen RED
    // row STILL must not dim. The escalation gate reads the result cache, not the
    // tint CSS class, so it can't be defeated by disabling the cosmetic tint. ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueRowTint: false, queueSeenDimming: true } };
    const rowIdRedNoTint = 'c0000000-0000-4000-8000-000000000009';
    const rowRedNoTint = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdRedNoTint, dob: '01 Jan 1980 (46y)' });
    const gridRootRedNoTint = new El('div', {});
    gridRootRedNoTint.appendChild(rowRedNoTint.master);
    gridRootRedNoTint.appendChild(rowRedNoTint.detail);
    sandbox.document = makeDocument(gridRootRedNoTint);
    sandbox.queueObservedContainer = gridRootRedNoTint;
    sandbox._durableRowMap.set(0, rowIdRedNoTint);
    sandbox._queueResultCache.set(rowIdRedNoTint, { sev: redSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdRedNoTint);

    sandbox.reapplyQueueRowTint(); // no-op: tint pref off, so NO tint class is set
    sandbox.reapplyQueueSeenDim();
    check(
      !rowRedNoTint.master.classes.includes('ch-row-sev-red'),
      'cross-pref sanity: with queueRowTint off, no tint class is applied'
    );
    check(
      !rowRedNoTint.master.classes.includes('ch-row-seen'),
      'SAFETY (cross-pref): tint OFF + seen ON — a seen RED row is STILL never dimmed (cache-truth gate)'
    );

    // ---- HARD SAFETY GATE: a seen AMBER row NEVER dims ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdAmberSeen = 'c0000000-0000-4000-8000-000000000004';
    const rowAmberSeen = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdAmberSeen, dob: '01 Jan 1980 (46y)' });
    const gridRootAmberSeen = new El('div', {});
    gridRootAmberSeen.appendChild(rowAmberSeen.master);
    gridRootAmberSeen.appendChild(rowAmberSeen.detail);
    sandbox.document = makeDocument(gridRootAmberSeen);
    sandbox.queueObservedContainer = gridRootAmberSeen;
    sandbox._durableRowMap.set(0, rowIdAmberSeen);
    sandbox._queueResultCache.set(rowIdAmberSeen, { sev: amberSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdAmberSeen);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(
      !rowAmberSeen.master.classes.includes('ch-row-seen'),
      'SAFETY: a seen AMBER row is NEVER dimmed, even though its taskUuid is in _seenTasks'
    );

    // ---- AUTO-UNDIM: a seen row that later re-grades red loses the dim on
    //      the very next reapply cycle, with no separate "undo" step ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdEscalate = 'c0000000-0000-4000-8000-000000000005';
    const rowEscalate = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdEscalate, dob: '01 Jan 1980 (46y)' });
    const gridRootEscalate = new El('div', {});
    gridRootEscalate.appendChild(rowEscalate.master);
    gridRootEscalate.appendChild(rowEscalate.detail);
    sandbox.document = makeDocument(gridRootEscalate);
    sandbox.queueObservedContainer = gridRootEscalate;
    sandbox._durableRowMap.set(0, rowIdEscalate);
    sandbox._queueResultCache.set(rowIdEscalate, { sev: noneSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdEscalate);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(rowEscalate.master.classes.includes('ch-row-seen'), 'auto-undim setup: dimmed while cached clear');

    // A new (more severe) result lands for the same task.
    sandbox._queueResultCache.set(rowIdEscalate, { sev: redSev, ts: Date.now() });
    // The full churn-cycle sequence refreshQueueChips runs: wipe both marker
    // classes, then re-derive both fresh from the (now-updated) cache.
    sandbox.clearQueueRowTint();
    sandbox.clearQueueSeenDim();
    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(
      !rowEscalate.master.classes.includes('ch-row-sev-red'),
      'auto-undim: re-grading red does not paint a result tint'
    );
    check(
      !rowEscalate.master.classes.includes('ch-row-seen'),
      'auto-undim: the SAME row automatically loses ch-row-seen the moment it re-grades red — no separate undo step'
    );

    // ---- pref off = no dim, even for an otherwise-eligible seen clear row ----
    freshCaches();
    sandbox.CONFIG = {}; // PREF('queueSeenDimming', false) -> false by default
    const rowIdPrefOff = 'c0000000-0000-4000-8000-000000000006';
    const rowPrefOff = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdPrefOff, dob: '01 Jan 1980 (46y)' });
    const gridRootPrefOff = new El('div', {});
    gridRootPrefOff.appendChild(rowPrefOff.master);
    gridRootPrefOff.appendChild(rowPrefOff.detail);
    sandbox.document = makeDocument(gridRootPrefOff);
    sandbox.queueObservedContainer = gridRootPrefOff;
    sandbox._durableRowMap.set(0, rowIdPrefOff);
    sandbox._queueResultCache.set(rowIdPrefOff, { sev: noneSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdPrefOff);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(
      !rowPrefOff.master.classes.includes('ch-row-seen'),
      'prefs.queueSeenDimming=false (default): reapplyQueueSeenDim is a no-op even for an eligible seen-clear row'
    );
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };

    // ---- churn: the dim survives a full wipe/reapply cycle, but ONLY for a
    //      row that is STILL clear — a sibling row that escalated in the same
    //      churn does not come back dimmed ----
    freshCaches();
    sandbox.CONFIG = { prefs: { queueSeenDimming: true } };
    const rowIdStillClear = 'c0000000-0000-4000-8000-000000000007';
    const rowIdNowRed = 'c0000000-0000-4000-8000-000000000008';
    const rowStillClear = buildPreviewRowPair({ rowIndex: 0, rowId: rowIdStillClear, dob: '01 Jan 1980 (46y)' });
    const rowNowRed = buildPreviewRowPair({ rowIndex: 1, rowId: rowIdNowRed, dob: '01 Jan 1980 (46y)' });
    const gridRootMixed = new El('div', {});
    [rowStillClear, rowNowRed].forEach(({ master, detail }) => {
      gridRootMixed.appendChild(master);
      gridRootMixed.appendChild(detail);
    });
    sandbox.document = makeDocument(gridRootMixed);
    sandbox.queueObservedContainer = gridRootMixed;
    sandbox._durableRowMap.set(0, rowIdStillClear);
    sandbox._durableRowMap.set(1, rowIdNowRed);
    sandbox._queueResultCache.set(rowIdStillClear, { sev: noneSev, ts: Date.now() });
    sandbox._queueResultCache.set(rowIdNowRed, { sev: noneSev, ts: Date.now() });
    sandbox._seenTasks.add(rowIdStillClear);
    sandbox._seenTasks.add(rowIdNowRed);

    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(
      rowStillClear.master.classes.includes('ch-row-seen') && rowNowRed.master.classes.includes('ch-row-seen'),
      'churn setup: both seen clear rows start dimmed'
    );

    // One of the two escalates; simulate the churn cycle.
    sandbox._queueResultCache.set(rowIdNowRed, { sev: amberSev, ts: Date.now() });
    sandbox.clearQueueRowTint();
    sandbox.clearQueueSeenDim();
    sandbox.reapplyQueueRowTint();
    sandbox.reapplyQueueSeenDim();
    check(
      rowStillClear.master.classes.includes('ch-row-seen'),
      'churn: the row that is STILL clear comes back dimmed after the wipe/reapply cycle'
    );
    check(
      !rowNowRed.master.classes.includes('ch-row-sev-amber') && !rowNowRed.master.classes.includes('ch-row-seen'),
      'churn: the row that escalated to amber is not tinted and not dimmed'
    );

    sandbox.CONFIG = {}; // restore default for any tests that might run after this block
  }

  // ============================================================
  // Layer 25 — items 4.1/4.2 (TRIAGE-LENS-2026-07-02.md): Pharmacy First
  // divert chip + missing-info ask-back, wired to the ALREADY-BUILT
  // reception-match engine (engine/reception-match.js,
  // window.SentinelReceptionMatch) via decorateOneRow + the new
  // showPathwayMenu popover (reusing the SAME activeActionMenu/
  // renderRuleMenuActionItems/executeAction infra as showRuleMatchMenu —
  // items 2.1/2.3/2.5). Exercises the REAL engine + REAL
  // rules/reception-pathways.json content (not stubbed), same convention as
  // Layer 19's window.TriageLensMatch. PREPARE-ONLY: every "copy" button
  // writes to the navigator.clipboard mock below and NEVER calls anything
  // that sends/files.
  // ============================================================
  console.log(
    '\nLayer 25: items 4.1/4.2 — Pharmacy First divert chip + missing-info ask-back (reception-match engine)'
  );

  {
    const ReceptionMatch = require('./engine/reception-match.js');
    const receptionPathwaysData = require('./rules/reception-pathways.json');
    // Fixture text reused across scenarios — matches the "earache" pathway
    // (SYNONYM_TERMS), whose pharmacyFirst block carries BOTH ageMin(1) and
    // ageMax(17) (the most robust "age-unknown fails closed" case — a
    // pathway with neither bound can't demonstrate the fail-closed gate at
    // all), and whose text volunteers the rf-mastoid red flag ("swelling
    // behind the ear", escalate '999') while leaving every other red flag on
    // that pathway (meningism/head-injury/sudden-deaf/facial-droop/
    // unwell-child/under3m-fever) as a gap — so ONE fixture exercises the PF
    // chip, the ask-back gaps, AND the flaggedInText escalation note together.
    // Verified directly against the real engine before writing these assertions.
    const requestText = 'Earache since yesterday, with some swelling behind the ear.';
    const expectedGapIds = [
      'rf-meningism',
      'rf-head-injury',
      'rf-sudden-deaf',
      'rf-facial-droop',
      'rf-unwell-child',
      'rf-under3m-fever',
    ];

    let clipboardWrites;
    const mockClipboard = () => {
      clipboardWrites = [];
      sandbox.navigator = {
        clipboard: {
          writeText: (text) => {
            clipboardWrites.push(text);
            return Promise.resolve();
          },
        },
      };
    };

    const setupRow = ({ rowIndex = 0, rowId, dob, text = requestText }) => {
      const { master, detail, wrap } = buildPreviewRowPair({ rowIndex, rowId, dob });
      wrap.children[0].textContent = 'Request: ' + text;
      const gridRoot = new El('div', {});
      gridRoot.appendChild(master);
      gridRoot.appendChild(detail);
      sandbox.document = makeDocument(gridRoot);
      sandbox.queueObservedContainer = gridRoot;
      return { master, wrap };
    };

    // ---- known age within the pathway's PF band -> green "Pharmacy First"
    //      chip renders (never an "Ask-back" chip on the SAME row — one
    //      pathway chip per row) ----
    freshCaches();
    mockClipboard();
    sandbox.matchRules = () => [];
    sandbox._receptionPathwaysData = receptionPathwaysData;
    const rowIdA = 'e0000000-0000-4000-8000-000000000001';
    const { wrap: wrapA } = setupRow({ rowId: rowIdA, dob: '01 Jan 2018 (8y)' });
    sandbox.decorateOneRow(sandbox.document.querySelector(`[row-id="${rowIdA}"]`));

    const ruleChipsA = wrapA.querySelectorAll('.ch-q-rule-chip');
    check(
      ruleChipsA.some((c) => c.textContent.includes('Pharmacy First')) &&
        !ruleChipsA.some((c) => c.textContent.includes('Ask-back')),
      `known-age pathway row paints Pharmacy First and not a second ask-back chip (got ${ruleChipsA.map((c) => c.textContent).join(' | ')})`
    );

    // ---- age UNKNOWN on the SAME matched pathway/text: PF chip fails closed
    //      (never rendered), but the ask-back chip still surfaces the
    //      volunteered red flag — a safety signal that must not disappear
    //      just because Pharmacy First itself can't be confirmed ----
    freshCaches();
    mockClipboard();
    sandbox.matchRules = () => [];
    sandbox._receptionPathwaysData = receptionPathwaysData;
    const rowIdB = 'e0000000-0000-4000-8000-000000000002';
    const { wrap: wrapB } = setupRow({ rowId: rowIdB, dob: 'Unknown' }); // no "(NNy)" -> ageMatch never fires
    sandbox.decorateOneRow(sandbox.document.querySelector(`[row-id="${rowIdB}"]`));

    const ruleChipsB = wrapB.querySelectorAll('.ch-q-rule-chip');
    check(
      ruleChipsB.some((c) => c.textContent.includes('Ask-back')) &&
        !ruleChipsB.some((c) => c.textContent.includes('Pharmacy First')),
      `age-unknown pathway row paints Ask-back and not Pharmacy First (got ${ruleChipsB.map((c) => c.textContent).join(' | ')})`
    );

    // ---- pref gate: requestPathwayChips=false suppresses BOTH chip kinds outright ----
    freshCaches();
    sandbox.CONFIG = { prefs: { requestPathwayChips: false } };
    sandbox.matchRules = () => [];
    sandbox._receptionPathwaysData = receptionPathwaysData;
    const rowIdC = 'e0000000-0000-4000-8000-000000000003';
    const { wrap: wrapC } = setupRow({ rowId: rowIdC, dob: '01 Jan 2018 (8y)' });
    sandbox.decorateOneRow(sandbox.document.querySelector(`[row-id="${rowIdC}"]`));
    check(
      !wrapC.querySelectorAll('.ch-q-rule-chip').some((c) => /Pharmacy First|Ask-back/.test(c.textContent)),
      'requestPathwayChips=false suppresses the Pharmacy First/Ask-back chip even though the same row would otherwise qualify (the age system chip, unrelated to this pref, still renders)'
    );
    sandbox.CONFIG = {}; // restore default (PREF('requestPathwayChips', true) -> true)

    // ---- no pathway match at all: no throw, no pathway chip ----
    freshCaches();
    sandbox.matchRules = () => [];
    sandbox._receptionPathwaysData = receptionPathwaysData;
    const rowIdD = 'e0000000-0000-4000-8000-000000000004';
    const { wrap: wrapD } = setupRow({
      rowId: rowIdD,
      dob: '01 Jan 1980 (46y)',
      text: 'Requesting a repeat prescription for statins please.',
    });
    sandbox.decorateOneRow(sandbox.document.querySelector(`[row-id="${rowIdD}"]`));
    check(
      !wrapD.querySelectorAll('.ch-q-rule-chip').some((c) => /Pharmacy First|Ask-back/.test(c.textContent)),
      'request text matching no pathway: no Pharmacy First/Ask-back chip, no throw'
    );

    // ---- _receptionPathwaysData not yet loaded (null): safe no-op, matches the
    //      "fetch hasn't resolved yet" race documented on ensureReceptionPathwaysLoaded ----
    freshCaches();
    sandbox.matchRules = () => [];
    sandbox._receptionPathwaysData = null;
    const rowIdE = 'e0000000-0000-4000-8000-000000000005';
    const { wrap: wrapE } = setupRow({ rowId: rowIdE, dob: '01 Jan 2018 (8y)' });
    sandbox.decorateOneRow(sandbox.document.querySelector(`[row-id="${rowIdE}"]`));
    check(
      !wrapE.querySelectorAll('.ch-q-rule-chip').some((c) => /Pharmacy First|Ask-back/.test(c.textContent)),
      '_receptionPathwaysData still null (fetch not yet resolved): pathway-chip block is a safe no-op, no throw'
    );

    sandbox._receptionPathwaysData = null;
    sandbox.matchRules = () => []; // restore the file's default stub for later scenarios
  }
} else {
  console.error('\nSandbox extraction failed — skipping all behavioural layers.');
}

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
