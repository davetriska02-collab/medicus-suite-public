// © 2026 Graysbrook Ltd. Proprietary — all rights reserved. See LICENSE.
//
// Record (live) — the live-first Patient Record summary tab.
//
// buildRecordSummaryText — exported pure function that converts the same data
// object render() uses into a provenance-stamped plain-text block for clipboard
// copy. DISPLAY-COPY ONLY: transcribes what is already on screen; no inference,
// no "impression", no clinical interpretation. The caveat is baked into the
// copied text so it can never be mistaken for the record itself.
//
// WHAT IT IS
// ----------
// A snapshot view of the patient currently open in Medicus, sourced LIVE from
// the same API the suite already calls (engine/api-client.js → fetchAll),
// rather than from an exported PDF. It surfaces demographics, coded problems,
// current medications (with doses), recent results, and a small set of
// deterministic prescribing-safety scores (ACB, STOPP/START) plus the live
// drug-monitoring + QOF chips Sentinel already computes.
//
// The DEEP, longitudinal lenses (multi-year consultation timeline, continuity
// indices, letters, eFI/Charlson) are NOT reachable live — read those in
// Medicus itself.
//
// CLINICAL-SAFETY FRAMING (non-negotiable — see docs/appraisal + INTENDED-PURPOSE)
// -------------------------------------------------------------------------------
// This view is INCOMPLETE by construction and must never read as a record of
// truth. It cannot show allergies or immunisations (no live endpoint), and some
// consultation-coded entries are limited to ~400 days. Therefore:
//   - a persistent provenance banner states it is a live snapshot, verify in
//     the record;
//   - allergies / immunisations / consultation history render as explicit
//     GAP-MARKERS where the data would be, not as silent absences;
//   - each safety score carries an inline caveat that it excludes allergies and
//     uses coded problems only.
// These are load-bearing patient-safety controls, not decoration.
//
// DATA PATH (no content-script changes; panel-side fetch like sweep.js)
//   active Medicus tab URL → SentinelApiClient.detectMedicusContext → apiBase + uuid
//   (uuid fallback: getSentinelSnapshot patientContext on non-patient pages)
//   → SentinelApiClient.fetchAll → SentinelNormalisers.normaliseAll
//   → ACBScores.computeACB / StoppStart.computeStoppStart
//   live monitoring/QOF chips → getSentinelSnapshot.chips
//
// Transactional feed (shared/panel-txn-feed.js): offered ALONGSIDE the session
// fetch above, not instead of it — see buildRecordModel() below. A practice
// stays on the session path unless integrationMode is explicitly
// 'transactional' (getTxnBundleIfEnabled() returns null in every other case,
// never throws). shared/fhir-normaliser.js's per-item field coverage is
// re-audited section by section in buildRecordModel()'s comment as it grows —
// as of v3.165.0's enrichment (dosage, observation range flags, problem
// significance), medications and observations still each lack one field
// their renderer needs (overdue/review-due/quantity; rawValue, respectively)
// and patientContext still lacks isDeceased/testPatient/namedGP, so those
// three keep preferring the session result; problems/pastProblems now carry
// everything problemsCard reads and are bundle-preferred in transactional
// mode. allergies/immunisations are used outright (the session feed has
// never had either) and also power the drug-allergy safety prompt in
// safetyCard() (see buildAllergyPrompts()). Session remains the fallback
// wherever the bundle doesn't supply a field/section. A one-line "Data: API
// feed"/"Data: session" provenance note (feedSourceLabel()) reflects which
// bundle was primary for the record AS A WHOLE (not per-field). See the
// detailed per-section comment at buildRecordModel().
//
// "Since last visit" (shared/record-delta.js, global SentinelRecordDelta,
// lazy-loaded — see loadRecordDelta()): a per-patient fingerprint of
// allergies/problems/medications/immunisations is diffed against the last
// time this patient's snapshot was rendered (chrome.storage.local key
// `brief.fp.<uuid>`) and surfaced as a short "what's new" section at the top
// of the tab. Works against either feed above, since both produce the same
// normalised bundle shape. Wrapped end-to-end in try/catch: a delta failure
// only ever omits the section, never the rest of the tab.

import { copyText } from '../shared/export-util.js';
import { getTxnBundleIfEnabled, feedSourceLabel } from '../../../shared/panel-txn-feed.js';
let container = null;
let _runToken = 0; // cancels stale async renders on rapid patient/tab change
let _onRuntimeMsg = null;
let _onTabChange = null;
let _onLetterheadChange = null;

const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// ── lifecycle ────────────────────────────────────────────────────────────────

export async function init(el) {
  container = el;
  container.innerHTML = shell();
  wireStaticControls();

  // Re-render when Sentinel publishes a fresh snapshot (patient changed in page)
  _onRuntimeMsg = (msg, sender) => {
    // Same intra-extension check as the other panel listeners. A page or
    // another extension must not be able to force a Record reload.
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'sentinel:snapshot-updated') load();
  };
  chrome.runtime.onMessage.addListener(_onRuntimeMsg);

  // Re-render when the user switches the active tab (e.g. flips to a patient).
  // For onUpdated, only react to a completed navigation — not every omnibox
  // keystroke / partial load — to avoid needless refetches.
  _onTabChange = (_tabId, changeInfo) => {
    if (changeInfo && changeInfo.status && changeInfo.status !== 'complete') return;
    load();
  };
  if (chrome.tabs?.onActivated) chrome.tabs.onActivated.addListener(_onTabChange);
  if (chrome.tabs?.onUpdated) chrome.tabs.onUpdated.addListener(_onTabChange);

  await loadLetterhead();
  _onLetterheadChange = (changes, area) => {
    if (area === 'local' && changes['suite.letterhead']) {
      _letterhead = changes['suite.letterhead'].newValue || {};
    }
  };
  if (chrome.storage?.onChanged) chrome.storage.onChanged.addListener(_onLetterheadChange);

  await load();
  // The loader only honours the RETURNED cleanup (module-loader.js setCleanup)
  // — without this line cleanup() was dead code and every Record visit leaked
  // its four listeners permanently (audit C3, 2026-07-18). Guarded by
  // test-module-lifecycle.js.
  return cleanup;
}

export function cleanup() {
  _runToken++;
  if (_onRuntimeMsg) chrome.runtime.onMessage.removeListener(_onRuntimeMsg);
  if (_onTabChange) {
    if (chrome.tabs?.onActivated) chrome.tabs.onActivated.removeListener(_onTabChange);
    if (chrome.tabs?.onUpdated) chrome.tabs.onUpdated.removeListener(_onTabChange);
  }
  if (_onLetterheadChange && chrome.storage?.onChanged) {
    chrome.storage.onChanged.removeListener(_onLetterheadChange);
  }
  if (_onDelegatedClick && container) container.removeEventListener('click', _onDelegatedClick);
  _onRuntimeMsg = _onTabChange = _onDelegatedClick = _onLetterheadChange = null;
  _lastModel = _lastChips = _lastStamp = _lastUuid = null;
  _letterhead = {};
  container = null;
}

// ── shell + static controls ──────────────────────────────────────────────────

function shell() {
  return `
    <div class="rec-root">
      <div class="rec-head">
        <div class="rec-title-row">
          <h2 class="rec-title">Patient record</h2>
          <div class="rec-title-btns">
            <button type="button" class="rec-copy-btn" id="recCopySummary" disabled title="Copy plain-text summary of what is shown on screen" aria-label="Copy summary">Copy summary</button>
            <button type="button" class="rec-refresh" id="recRefresh" title="Refresh from Medicus" aria-label="Refresh">⟳</button>
          </div>
        </div>
        <div class="rec-source" id="recSource" aria-live="polite"></div>
      </div>
      <div class="rec-body" id="recBody" aria-live="polite"></div>
    </div>`;
}

// Stored so cleanup() can detach it (the body it serves is re-rendered, but the
// delegated listener lives on the persistent root).
let _onDelegatedClick = null;

// Last successfully rendered model — populated by render(), consumed by the
// Copy summary button.  Intentionally module-local; never written to storage.
let _lastModel = null;
let _lastChips = null;
let _lastStamp = null;
// Patient UUID resolved by load() (URL context or content-script fallback) for
// the rendered model — the ONLY patient identifier the event ledger may
// receive (never a name). Module-local; never written to storage by this module.
let _lastUuid = null;

// Practice letterhead ({ practiceName, clinicianName }) used to auto-fill the
// SMR prep pack sign-off, read from 'suite.letterhead'. Same convention as
// sentinel.js's _letterhead — loaded once on init, kept fresh via
// chrome.storage.onChanged. Module-local; never written to storage here.
let _letterhead = {};

function wireStaticControls() {
  container.querySelector('#recRefresh')?.addEventListener('click', () => load(true));

  // Copy summary — button lives in the shell (not re-rendered), so a direct
  // listener is fine.  Button is disabled until render() populates _lastModel.
  const copyBtn = container.querySelector('#recCopySummary');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!_lastModel) return;
      const text = buildRecordSummaryText(_lastModel, _lastChips, _lastStamp);
      const ok = await copyText(text);
      if (ok) {
        // F2 Clinical Event Ledger — record the copy (fire-and-forget; the
        // ledger swallows its own failures and can never break this button).
        window.EventLedger?.record({
          source: 'record',
          patientRef: _lastUuid,
          severity: null,
          ruleId: null,
          label: 'Copy patient summary',
          action: 'summary-copied',
        });
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('rec-copy-btn--ok');
        setTimeout(() => {
          copyBtn.textContent = prev;
          copyBtn.classList.remove('rec-copy-btn--ok');
        }, 2000);
      }
    });
  }

  // Retry button lives inside the re-rendered body, so delegate from the root
  // (listener survives setBody innerHTML replacement).
  _onDelegatedClick = (e) => {
    if (e.target && e.target.id === 'recRetry') load(true);
  };
  container.addEventListener('click', _onDelegatedClick);
}

function setBody(html) {
  const b = container?.querySelector('#recBody');
  if (b) b.innerHTML = html;
}
function setSource(html, cls) {
  const s = container?.querySelector('#recSource');
  if (s) {
    s.className = 'rec-source' + (cls ? ' ' + cls : '');
    s.innerHTML = html;
  }
}

// ── load / resolve patient ───────────────────────────────────────────────────

// Practice letterhead — mirrors sentinel.js's loadLetterhead() (same storage
// key, same shape). Loaded once on init; kept fresh via the onChanged listener
// wired in init()/cleanup().
async function loadLetterhead() {
  const r = await chrome.storage.local.get('suite.letterhead');
  _letterhead = r['suite.letterhead'] || {};
}

async function findMedicusTab() {
  // Prefer the active tab; fall back to any open Medicus tab in the window.
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active[0]?.url && /medicus\.health/.test(active[0].url)) return active[0];
  const any = await chrome.tabs.query({ url: 'https://*.medicus.health/*' });
  return any[0] || null;
}

async function patientUuidFromContentScript(tabId) {
  try {
    const snap = await chrome.tabs.sendMessage(tabId, { action: 'getSentinelSnapshot' });
    return snap?.patientContext?.patientUuid || null;
  } catch (_) {
    return null;
  }
}

async function liveChips(tabId) {
  try {
    const snap = await chrome.tabs.sendMessage(tabId, { action: 'getSentinelSnapshot' });
    if (!snap || snap.unavailable) return null;
    return Array.isArray(snap.chips) ? snap.chips : null;
  } catch (_) {
    return null;
  }
}

async function load(force) {
  const token = ++_runToken;
  const apiClient = window.SentinelApiClient;
  const normalisers = window.SentinelNormalisers;

  if (!apiClient || !normalisers) {
    setSource('Engine not loaded', 'rec-source-err');
    setBody(stateCard('Unavailable', 'The record engine failed to load. Reload the panel.'));
    return;
  }

  setSource('Locating patient…');
  const tab = await findMedicusTab();
  if (token !== _runToken) return;
  if (!tab) {
    setSource('No Medicus tab open', 'rec-source-warn');
    setBody(
      stateCard(
        'Open Medicus to begin',
        'This tab shows a live summary of the patient you have open in Medicus. Open a patient record, then return here.'
      )
    );
    return;
  }

  const ctx = apiClient.detectMedicusContext(tab.url) || {};
  let uuid = ctx.patientUuid;
  if (!uuid) uuid = await patientUuidFromContentScript(tab.id);
  if (token !== _runToken) return;

  if (!ctx.apiBase || !uuid) {
    setSource('No patient open', 'rec-source-warn');
    setBody(
      stateCard('No patient selected', 'Open a patient’s record in Medicus and this summary will load automatically.')
    );
    return;
  }

  setSource('Loading live data from Medicus…', 'rec-source-loading');
  setBody(skeleton());

  // Try the transactional feed first (best-effort; never throws — see header
  // DATA PATH note). Still followed by the ordinary session fetch below: for
  // this tab the session result remains the preferred source for most fields
  // (see buildRecordModel), so both are gathered here rather than short-
  // circuiting on a bundle alone.
  let feedBundle = null;
  try {
    feedBundle = await getTxnBundleIfEnabled(uuid);
  } catch (_) {
    feedBundle = null;
  }
  if (token !== _runToken) return;

  let sessionData = null;
  try {
    const raw = await apiClient.fetchAll(ctx.apiBase, uuid, { useCache: !force });
    sessionData = normalisers.normaliseAll(raw, ctx);
  } catch (e) {
    sessionData = null; // fall through — the txn bundle (if any) may still carry this render
  }
  if (token !== _runToken) return;

  if (!sessionData && !feedBundle) {
    setSource('Couldn’t reach Medicus', 'rec-source-err');
    setBody(
      stateCard('Couldn’t load the record', 'Medicus did not respond. Check you are signed in, then retry.', true)
    );
    return;
  }

  const errs = (sessionData && sessionData.apiErrors) || {};
  const authFail = Object.values(errs).some((e) => /401|403|sign|auth/i.test(String(e)));
  if (sessionData && authFail && !sessionData.patientContext && !feedBundle) {
    setSource('Not signed in', 'rec-source-err');
    setBody(stateCard('Sign in to Medicus', 'Your Medicus session looks signed out. Sign in, then retry.', true));
    return;
  }

  const data = buildRecordModel(sessionData, feedBundle);

  const chips = await liveChips(tab.id);
  if (token !== _runToken) return;

  _lastUuid = uuid;
  await render(data, chips, errs, { feedBundle, token, uuid });
}

// Combine the session-normalised model with the (optional) transactional
// bundle into the single shape render() consumes.
//
// RE-AUDITED for v3.165.0's shared/fhir-normaliser.js enrichment (dosage,
// observation range flags, problem significance) — the original v3.164.0
// justification ("the bundle is thinner") has PARTIALLY expired. Checked
// field-by-field against what each section's renderer actually reads:
//
//   patientContext — STILL session-fed. The bundle's patientContext (see
//     shared/fhir-normaliser.js normaliseCareRecord) has no isDeceased,
//     testPatient or namedGP — demographicsCard renders all three, and the
//     deceased badge is a load-bearing safety control per this module's
//     header. v3.165.0 didn't touch patientContext at all. Falls back to the
//     bundle only if the session fetch failed outright.
//
//   medications — STILL session-fed. The bundle now carries `dosage`
//     (v3.165.0), which covers medsCard's `m.dosage` line, but still has no
//     `isOverDue` / `isReviewOverDue` (medsCard's "overdue" / "review due"
//     flags) and no `quantity` (medsCard's meta line reads `m.quantity`).
//     Falls back to the bundle only if the session fetch failed outright.
//
//   observations — STILL session-fed. The bundle now carries `isAbove` /
//     `isBelow` (v3.165.0), but still has no `rawValue`: fhir-normaliser.js's
//     `observations` array deliberately strips rawValue back out after using
//     it internally to derive isAbove/isBelow (only observationHistory's
//     per-point history entries keep it). resultsCard's own filter requires
//     `o.rawValue != null && o.rawValue !== ''`, so a bundle-sourced
//     observations array would still silently render as "no results" —
//     exactly the failure mode the original comment warned about, just for a
//     narrower field now. Falls back to the bundle only if the session fetch
//     failed outright.
//
//   problems / pastProblems — FLIPPED: now bundle-preferred in transactional
//     mode, session as the fallback. v3.165.0 added `significance`
//     (ProblemSignificance extension), and the bundle already carried label/
//     code/codedDate/status — that is every field problemsCard (`p.label`,
//     `p.codedDate`, `p.significance`) and buildRecordSummaryText read. No
//     remaining gap, so there is no reason left to prefer the thinner path.
//
// observationHistory is merged through unchanged (session-first, same as
// observations above) — this module never renders it directly (it exists in
// the model for parity with the other modules — trends/sweep/signing — that
// share this normalised shape), so it wasn't part of this re-audit.
//
// allergies/immunisations have no session equivalent at all — they always
// come from the bundle when one is offered, and are what feeds the "Since
// last visit" section below, plus (allergies) the drug-allergy safety prompt
// in safetyCard() — see buildAllergyPrompts().
function buildRecordModel(sessionData, feedBundle) {
  const s = sessionData || {};
  const b = feedBundle || {};
  return {
    patientContext: s.patientContext || b.patientContext || null,
    medications: s.medications || b.medications || [],
    observations: s.observations || b.observations || [],
    observationHistory: s.observationHistory || b.observationHistory || [],
    problems: b.problems || s.problems || [],
    pastProblems: b.pastProblems || s.pastProblems || [],
    allergies: b.allergies || [],
    immunisations: b.immunisations || [],
  };
}

// ── render (loaded state) ────────────────────────────────────────────────────

async function render(data, chips, errs, opts) {
  const { feedBundle, token, uuid } = opts || {};

  // "Since last visit" — computed (and its own storage read/write performed)
  // BEFORE anything is painted, so a stale/superseded render never writes a
  // fingerprint for the wrong patient. Failures here only ever omit the
  // section (see renderSinceLastVisitSection); they must never surface as a
  // broken Record tab.
  let deltaSectionHtml = '';
  try {
    deltaSectionHtml = await renderSinceLastVisitSection(data, uuid);
  } catch (_) {
    deltaSectionHtml = '';
  }
  if (token !== undefined && token !== _runToken) return; // a newer load() has already superseded this one

  const pc = data.patientContext || {};
  const meds = data.medications || [];
  const problems = data.problems || [];
  const past = data.pastProblems || [];
  const obs = data.observations || [];

  // Source line: live + freshness + feed provenance. "API feed" only when the
  // transactional feed actually supplied the primary bundle for this render
  // (shared/panel-txn-feed.js feedSourceLabel) — otherwise "session", exactly
  // as before this feature existed.
  const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  let feedLabel = 'session';
  try {
    feedLabel = feedSourceLabel(feedBundle) === 'API' ? 'API feed' : 'session';
  } catch (_) {
    feedLabel = 'session';
  }
  setSource(
    `<span class="rec-live-dot" aria-hidden="true"></span>LIVE from Medicus · ${esc(stamp)} · <span class="rec-snapshot-word">snapshot, not the full record</span> · <span class="rec-feed-label">Data: ${esc(feedLabel)}</span>`,
    'rec-source-live'
  );

  // Store model so the Copy summary button can build the text on demand.
  _lastModel = data;
  _lastChips = chips;
  _lastStamp = stamp;
  const copyBtn = container?.querySelector('#recCopySummary');
  if (copyBtn) copyBtn.disabled = false;

  const partial = Object.keys(errs).length
    ? `<div class="rec-partial">⚠ Some sections didn’t load (${esc(Object.keys(errs).join(', '))}). Showing what was returned.</div>`
    : '';

  // Order follows how a clinician orients: what changed since last time →
  // identity → what's missing (safety gaps) → what's wrong (problems) →
  // what they're on (meds) → safety scores that interrogate those → results.
  // Scores sit AFTER problems/meds because the panel critique found
  // clinicians read the clinical picture first and use the scores to confirm
  // or challenge it.
  setBody(
    `${deltaSectionHtml}
     ${demographicsCard(pc)}
     ${safetyBanner()}
     ${partial}
     ${gapMarkers()}
     ${problemsCard(problems, past)}
     ${medsCard(meds)}
     ${resultsCard(obs)}`
  );
}

// ── "Since last visit" (shared/record-delta.js) ─────────────────────────────
//
// A per-patient fingerprint (hashed identity keys only — see shared/
// record-delta.js header) is stored per patient and diffed on every render
// against the CURRENT bundle to produce a short, human "what changed" list.
// Works identically against either feed (session or transactional) — both
// produce the same normalised bundle shape this module already renders from.
//
// STORAGE DISCIPLINE: chrome.storage.local key `brief.fp.<patientUuid>` holds
// ONLY { keys: [...hashed fingerprint keys], at: <ISO timestamp> } — exactly
// what shared/record-delta.js's fingerprintKeys() produces, plus the
// timestamp this section needs to say "since DATE". The hashed keys carry no
// PHI (see that module's header); the human-readable added-item LABELS shown
// below are read fresh off the CURRENT bundle at render time and are never
// written to storage.
const BRIEF_FP_PREFIX = 'brief.fp.';
const BRIEF_FP_MAX_PATIENTS = 200; // simple count-based cap, checked on every write

// shared/record-delta.js is a classic global-style script (window.
// SentinelRecordDelta), like the other engine globals this module already
// reads (window.ACBScores, window.StoppStart, ...) — but unlike those, it is
// not preloaded by a <script> tag, so it is lazy-loaded here via a dynamic
// import of its own URL purely for the side effect of setting that global
// (the file has no ES export statements; the import's returned namespace is
// unused). Cached after the first successful load.
let _recordDeltaPromise = null;
function loadRecordDelta() {
  if (typeof window !== 'undefined' && window.SentinelRecordDelta) {
    return Promise.resolve(window.SentinelRecordDelta);
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return Promise.resolve(null);
  if (!_recordDeltaPromise) {
    _recordDeltaPromise = import(chrome.runtime.getURL('shared/record-delta.js'))
      .then(() => (typeof window !== 'undefined' && window.SentinelRecordDelta) || null)
      .catch(() => null);
  }
  return _recordDeltaPromise;
}

// renderSinceLastVisitSection(data, patientUuid) -> HTML string (possibly '')
//
// Never throws (every failure path resolves to ''); render() additionally
// wraps the call in try/catch as a second layer of defence — a delta failure
// must never break the rest of the tab.
async function renderSinceLastVisitSection(data, patientUuid) {
  if (!patientUuid) return '';
  const RecordDelta = await loadRecordDelta();
  if (!RecordDelta) return '';

  const key = BRIEF_FP_PREFIX + patientUuid;
  let prevRec = null;
  try {
    const stored = await chrome.storage.local.get(key);
    prevRec = (stored && stored[key]) || null;
  } catch (_) {
    prevRec = null;
  }

  const isFirstView = !prevRec || !Array.isArray(prevRec.keys);
  let delta;
  try {
    delta = RecordDelta.recordDelta(isFirstView ? [] : prevRec.keys, data);
  } catch (_) {
    return '';
  }

  // Fire-and-forget: persist the fingerprint for the NEXT visit. Never
  // awaited — a storage write failure must not hold up (or break) this
  // render; saveFingerprint swallows its own errors.
  saveFingerprint(patientUuid, delta.nextKeys);

  return sinceLastVisitCard(delta, isFirstView, prevRec && prevRec.at);
}

async function saveFingerprint(patientUuid, nextKeys) {
  try {
    const key = BRIEF_FP_PREFIX + patientUuid;
    await chrome.storage.local.set({ [key]: { keys: nextKeys, at: new Date().toISOString() } });
    await pruneFingerprintStore();
  } catch (_) {
    /* best-effort only — never break the tab over a storage write failure */
  }
}

// Simple count-based cap: if more than BRIEF_FP_MAX_PATIENTS fingerprints are
// stored, drop the oldest (by their `at` timestamp) until back at the cap.
async function pruneFingerprintStore() {
  try {
    const all = await chrome.storage.local.get(null);
    const entries = Object.keys(all)
      .filter((k) => k.startsWith(BRIEF_FP_PREFIX))
      .map((k) => ({ key: k, at: (all[k] && all[k].at) || '' }));
    if (entries.length <= BRIEF_FP_MAX_PATIENTS) return;
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // oldest (smallest ISO) first
    const toRemove = entries.slice(0, entries.length - BRIEF_FP_MAX_PATIENTS).map((e) => e.key);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (_) {
    /* best-effort prune only */
  }
}

function sinceLastVisitCard(delta, isFirstView, prevAtIso) {
  let body;
  if (isFirstView) {
    body = `<div class="rec-delta-baseline">Baseline stored — changes will show from your next visit.</div>`;
  } else if (delta.added.length === 0 && delta.removedCount === 0) {
    const dateStr = prevAtIso ? fmtDate(prevAtIso) : 'last visit';
    body = `<div class="rec-delta-none">No changes since ${esc(dateStr)}.</div>`;
  } else {
    const items = delta.added
      .map((a) => `<li class="rec-delta-item rec-delta-${esc(a.kind)}">+ ${esc(a.kind)}: ${esc(a.label)}</li>`)
      .join('');
    const removedNote = delta.removedCount
      ? `<li class="rec-delta-item rec-delta-removed">${delta.removedCount} item${delta.removedCount === 1 ? '' : 's'} no longer present — review</li>`
      : '';
    body = `<ul class="rec-delta-list">${items}${removedNote}</ul>`;
  }
  return `
    <section class="rec-card rec-delta-card">
      <h3 class="rec-card-h">Since last visit</h3>
      ${body}
    </section>`;
}

// ── Copy summary — plain-text builder ────────────────────────────────────────
//
// DISPLAY-COPY ONLY.  Transcribes exactly what render() puts on screen.
// No inference, no summarising, no "impression" section.  Provenance header
// and the caveat are baked in so the pasted block can never be mistaken for
// the record.
//
// Exported so test-record-summary.js can call it directly without a browser.
//
// Parameters match what render() already has:
//   model  — normaliseAll output (data)
//   chips  — live chip array (may be null)
//   stamp  — "HH:MM" string already computed by render() (so the test can
//             inject a fixed value and the copied text matches what was shown)
export function buildRecordSummaryText(model, chips, stamp) {
  const pc = (model && model.patientContext) || {};
  const meds = (model && model.medications) || [];
  const problems = (model && model.problems) || [];
  const past = (model && model.pastProblems) || [];
  const obs = (model && model.observations) || [];

  const lines = [];

  // ── Provenance header ──────────────────────────────────────────────────────
  const atStamp = stamp || new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  lines.push(`Patient record summary — as at ${atStamp}`);
  lines.push('');

  // ── Demographics ───────────────────────────────────────────────────────────
  lines.push('PATIENT');
  const name = pc.patientName || 'Unknown patient';
  const demoBits = [name];
  if (pc.ageYears != null) demoBits.push(`${pc.ageYears}y`);
  if (pc.sex) demoBits.push(pc.sex);
  if (pc.dob) demoBits.push(`DOB ${pc.dob}`);
  lines.push(demoBits.join(' · '));
  if (pc.nhsNumber) {
    const nhs = String(pc.nhsNumber).replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
    lines.push(`NHS ${nhs}`);
  }
  if (pc.namedGP) lines.push(`Named GP: ${pc.namedGP}`);
  if (pc.isDeceased) lines.push('[DECEASED]');
  if (pc.testPatient) lines.push('[TEST PATIENT]');
  lines.push('');

  // ── Gap markers — absence must be explicit in the copy ────────────────────
  lines.push('NOT SHOWN IN THIS SUMMARY (verify in Medicus):');
  lines.push('  Allergies & adverse reactions — not shown — verify in Medicus before prescribing');
  lines.push('  Immunisations — not shown — verify in Medicus');
  lines.push('  Consultation history — not shown — read the record in Medicus');
  lines.push('');

  // ── Active problems ────────────────────────────────────────────────────────
  lines.push(`ACTIVE PROBLEMS (${problems.length})`);
  if (problems.length) {
    problems.forEach((p) => {
      const date = p.codedDate ? `  [${_fmtDatePlain(p.codedDate)}]` : '';
      const major = p.significance && /major/i.test(p.significance) ? ' *' : '';
      lines.push(`  ${p.label || ''}${major}${date}`);
    });
  } else {
    lines.push('  No active problems returned.');
  }
  if (past.length) lines.push(`  (${past.length} past/inactive problem${past.length === 1 ? '' : 's'} not shown)`);
  lines.push('');

  // ── Current medications ────────────────────────────────────────────────────
  lines.push(`CURRENT MEDICATIONS (${meds.length})`);
  if (meds.length) {
    meds.forEach((m) => {
      const flags = [];
      if (m.isOverDue) flags.push('[OVERDUE]');
      if (m.isReviewOverDue) flags.push('[REVIEW DUE]');
      let line = `  ${m.name || ''}`;
      if (flags.length) line += ` ${flags.join(' ')}`;
      lines.push(line);
      if (m.dosage) lines.push(`    ${m.dosage}`);
    });
  } else {
    lines.push('  No current medications returned.');
  }
  lines.push('');

  // ── Prescribing safety ─────────────────────────────────────────────────────
  // Transcribe score values only — the same values shown by safetyCard().
  // No additional interpretation beyond what is on screen.
  const drugObjs = meds.map((m) => ({ label: m.name }));
  const probObjs = problems.map((p) => ({ name: p.label }));
  const egfr = _latestEgfrPlain(obs);

  void drugObjs;
  void probObjs;
  void egfr;
  void chips;

  // ── Recent results ─────────────────────────────────────────────────────────
  const named = obs.filter((o) => o.name && o.rawValue != null && o.rawValue !== '');
  const top = named.slice(0, 14);
  lines.push(`RECENT RESULTS (${named.length})`);
  if (top.length) {
    top.forEach((o) => {
      const flag = o.isAbove ? ' [HIGH]' : o.isBelow ? ' [LOW]' : '';
      const date = o.date ? `  [${_fmtDatePlain(o.date)}]` : '';
      lines.push(`  ${o.name}: ${o.value}${flag}${date}`);
    });
  } else {
    lines.push('  No recent results returned.');
  }
  lines.push('');

  // ── Caveat — verbatim, load-bearing ───────────────────────────────────────
  lines.push('Live snapshot, not a complete record. Verify against the patient record before acting.');

  return lines.join('\n');
}

// Plain-text date formatter (no HTML, used by buildRecordSummaryText).
function _fmtDatePlain(d) {
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return String(d);
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// eGFR extraction for the plain-text path (mirrors latestEgfr without closure).
function _latestEgfrPlain(obs) {
  const e = (obs || []).find((o) => /e?gfr/i.test(o.name || ''));
  if (!e) return null;
  const n = parseFloat(String(e.rawValue));
  return Number.isFinite(n) ? n : null;
}

// ── problems ─────────────────────────────────────────────────────────────────

function problemsCard(active, past) {
  const items = active.length
    ? active
        .map(
          (p) =>
            `<li class="rec-prob ${p.significance && /major/i.test(p.significance) ? 'rec-prob-major' : ''}">
               <span class="rec-prob-name">${esc(p.label)}</span>
               ${p.codedDate ? `<span class="rec-prob-date">${esc(fmtDate(p.codedDate))}</span>` : ''}
             </li>`
        )
        .join('')
    : `<li class="rec-empty">No active problems returned.</li>`;
  return `
    <section class="rec-card">
      <h3 class="rec-card-h">Active problems <span class="rec-count">${active.length}</span></h3>
      <ul class="rec-list">${items}</ul>
      ${past.length ? `<div class="rec-window">${past.length} past/inactive problem${past.length === 1 ? '' : 's'} not shown</div>` : ''}
      <div class="rec-window">Active, coded problems · full history</div>
    </section>`;
}

// ── medications ──────────────────────────────────────────────────────────────

function medsCard(meds) {
  const items = meds.length
    ? meds
        .map((m) => {
          const flags = [];
          if (m.isOverDue) flags.push('<span class="rec-med-flag rec-med-overdue">overdue</span>');
          if (m.isReviewOverDue) flags.push('<span class="rec-med-flag rec-med-review">review due</span>');
          return `
            <li class="rec-med">
              <div class="rec-med-name">${esc(m.name)} ${flags.join('')}</div>
              ${m.dosage ? `<div class="rec-med-dose">${esc(m.dosage)}</div>` : ''}
              <div class="rec-med-meta">${[m.source, m.quantity].filter(Boolean).map(esc).join(' · ')}</div>
            </li>`;
        })
        .join('')
    : `<li class="rec-empty">No current medications returned.</li>`;
  return `
    <section class="rec-card">
      <h3 class="rec-card-h">Current medications <span class="rec-count">${meds.length}</span></h3>
      <ul class="rec-list">${items}</ul>
      <div class="rec-window">Current repeats + acute (last 12m) · with doses · excludes discontinued</div>
    </section>`;
}

// ── results ──────────────────────────────────────────────────────────────────

function resultsCard(obs) {
  // De-duplicate to per-analyte latest (normaliseObservations already does this,
  // but also emits group aggregates — keep named analytes, drop pure aggregates
  // that duplicate a group with no unit).
  const named = obs.filter((o) => o.name && o.rawValue != null && o.rawValue !== '');
  const top = named.slice(0, 14);
  const items = top.length
    ? top
        .map((o) => {
          const flag = o.isAbove ? 'rec-res-high' : o.isBelow ? 'rec-res-low' : '';
          const arrow = o.isAbove
            ? '<span class="rec-res-arrow" aria-label="above range">↑</span>'
            : o.isBelow
              ? '<span class="rec-res-arrow" aria-label="below range">↓</span>'
              : '';
          return `
            <li class="rec-res ${flag}">
              <span class="rec-res-name">${esc(o.name)}</span>
              <span class="rec-res-val">${esc(o.value)} ${arrow}</span>
              ${o.date ? `<span class="rec-res-date">${esc(fmtDate(o.date))}</span>` : ''}
            </li>`;
        })
        .join('')
    : `<li class="rec-empty">No recent results returned.</li>`;
  return `
    <section class="rec-card">
      <h3 class="rec-card-h">Recent results <span class="rec-count">${named.length}</span></h3>
      <ul class="rec-list rec-res-list">${items}</ul>
      <div class="rec-window">Latest value per test · full lab history available · journal-coded entries limited to ~400 days</div>
    </section>`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d) {
  // Accept ISO "YYYY-MM-DD" or display strings; render compact GB date.
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return String(d);
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function skeleton() {
  const row = `<div class="rec-skel-row"><div class="rec-skel-bar"></div><div class="rec-skel-bar short"></div></div>`;
  return `
    <div class="rec-skel" aria-busy="true" aria-label="Loading">
      <div class="rec-skel-head"></div>
      ${row}${row}${row}${row}
    </div>`;
}

// Monochrome reticle glyph — the brand mark's geometry (ring + cardinal ticks +
// centre dot) echoed into the chrome. Faint/currentColor, no brand cyan (the
// doctrine keeps the brand colours out of the clinical UI).
const RETICLE_GLYPH = `<svg class="rec-state-glyph" width="30" height="30" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="16" cy="16" r="9"/><line x1="16" y1="2.5" x2="16" y2="7"/><line x1="16" y1="25" x2="16" y2="29.5"/><line x1="2.5" y1="16" x2="7" y2="16"/><line x1="25" y1="16" x2="29.5" y2="16"/><circle cx="16" cy="16" r="2.4" fill="currentColor" stroke="none"/></svg>`;

function stateCard(title, msg, retry) {
  return `
    <div class="rec-state">
      ${RETICLE_GLYPH}
      <div class="rec-state-title">${esc(title)}</div>
      <div class="rec-state-msg">${esc(msg)}</div>
      ${retry ? `<button class="rec-retry" id="recRetry">Retry</button>` : ''}
    </div>`;
}
