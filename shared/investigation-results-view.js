// Medicus Suite — "Investigation results" view model (Companion lab-filing card rework, Clinician A, 2026-10-04)
//
// Pure functions, no DOM, no chrome.*: they turn the structured reasons the gate already computes into what the Companion
// shows — per report group, per result — and join the outstanding requests with what the matcher decided. The Companion
// renders the result; nothing here decides whether anything may be filed (that stays with the gate's own blockers).
//
//   buildGroupsView({ report, items, blockers, comments, setups, undoable })
//       -> { total, needReview, groups: [...], reportReasons: [...] }
//   buildRequestsView({ requests, journal, groups, norm, parseName })
//       -> { rows, here: [...] | null, elsewhere: [...] }
//
// THE RULE THAT MATTERS: nothing is ever dropped. Every reason the gate raised ends up either under a group/result or in
// `reportReasons` — and any blocker string no structured item accounts for is appended there as kind 'other'. A card built
// from this can never say "all in normal limits" for a group that has a blocker, and can never hide a blocker it could not place.
(function (global) {
  'use strict';

  const isStr = (v) => typeof v === 'string';
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const normHeading = (h) =>
    String(h == null ? '' : h)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  // Which part of the card a reason belongs to.
  const LIMITS = new Set([
    'not-within-limits',
    'clinical-rule',
    'below-practice-range',
    'above-practice-range',
    'lab-flagged-abnormal',
    'no-range-to-judge',
    'trend-exceeded',
  ]);
  const COMMENT = new Set(['comment', 'comment-not-whitelisted']);
  const SETUP = new Set(['group-not-approved', 'no-heading']);

  // A reason's wording without the result's name or value ("Haemoglobin (93 g/L) is below your practice minimum of 100" ->
  // "below your practice minimum of 100"), so a per-result list does not repeat the name on every line.
  function shortReason(item) {
    const text = isStr(item && item.text) ? item.text : '';
    const name = isStr(item && item.result) ? item.result : '';
    if (!name || !text.startsWith(name)) return text;
    const rest = text
      .slice(name.length)
      .replace(/^\s*(\([^)]*\))?\s*/, '')
      .replace(/^is\s+/i, '') // "has …" keeps its verb: the card adds "is" only to reasons that lack one
      .trim();
    return rest || text;
  }
  // " (93 g/L)" when the reason carries the result's value right after its name.
  function valueOf(item) {
    const text = isStr(item && item.text) ? item.text : '';
    const name = isStr(item && item.result) ? item.result : '';
    if (!name || !text.startsWith(name)) return '';
    const m = text.slice(name.length).match(/^\s*\(([^)]*)\)/);
    return m ? m[1].trim() : '';
  }

  const SUMMARY_ORDER = [
    ['limits', 'Not within normal limits'],
    ['free-text', 'Free-text result'],
    ['comment', 'Unrecognised comment'],
    ['comment-pending', 'Whitelisted comment not approved'],
    ['setup', 'Not set up for assisted filing'],
    ['setup-awaiting', 'Awaiting approval'],
    ['other', 'Other'],
  ];

  function buildGroupsView(inp) {
    const input = inp || {};
    const rows = input.report && Array.isArray(input.report.results) ? input.report.results.filter(Boolean) : [];
    const items = asArr(input.items).filter(Boolean);
    const blockers = asArr(input.blockers).filter(isStr);
    const commentRows = asArr(input.comments).filter(Boolean);
    const setupRows = asArr(input.setups).filter(Boolean);
    const undoable = input.undoable && typeof input.undoable.has === 'function' ? input.undoable : null;

    // ── the report's groups, in report order ─────────────────────────────────────────────────────────────────────
    const groups = new Map(); // normHeading -> group
    const groupOfResult = new Map(); // normalised result name -> normHeading
    rows.forEach((r) => {
      const name = isStr(r.name) && r.name.trim() ? r.name.trim() : 'unnamed';
      const heading = isStr(r.groupHeading) && r.groupHeading.trim() ? r.groupHeading.trim() : name;
      const key = normHeading(heading);
      if (!groups.has(key)) {
        groups.set(key, {
          heading,
          key,
          cats: new Set(),
          perResult: new Map(),
          comments: [],
          setup: null,
          other: [],
        });
      }
      if (!groupOfResult.has(normHeading(name))) groupOfResult.set(normHeading(name), key);
    });

    const reportReasons = [];
    const covered = new Set();
    // The lab itself is not in the catalogue (nothing can be set up under it). That is not a separate report-wide problem —
    // it is why EVERY group here is "not set up" — so it is attached to each group below, and said there, once.
    let labMissing = null;
    const placeItem = (item) => {
      (item.covers || []).forEach((c) => covered.add(c));
      covered.add(item.text);
      if (item.kind === 'lab-not-set-up') {
        labMissing = labMissing || item.text;
        return;
      }
      let key = isStr(item.heading) && item.heading ? normHeading(item.heading) : null;
      if ((!key || !groups.has(key)) && isStr(item.result) && item.result)
        key = groupOfResult.get(normHeading(item.result)) || key;
      const g = key ? groups.get(key) : null;
      if (!g) {
        reportReasons.push({ kind: item.kind || 'other', text: item.text });
        return;
      }
      if (SETUP.has(item.kind)) {
        g.cats.add('setup');
        g.setup = g.setup || { state: item.state || 'no-setup', text: item.text, investigationId: null, label: null };
        return;
      }
      if (COMMENT.has(item.kind)) {
        // The comment itself (with its whitelist chip) is listed under the group when the engine offered it; this
        // per-result line only stands in when nothing else carries it (a legacy profile report).
        g.cats.add('comment');
        const name = item.result || 'a result';
        const r = g.perResult.get(name) || { name, valueText: '', reasons: [] };
        r.reasons.push({
          kind: 'comment',
          reason: 'carries a comment the suite cannot score',
          text: item.text,
          commentLine: true,
        });
        g.perResult.set(name, r);
        return;
      }
      const cat = item.kind === 'free-text' ? 'free-text' : LIMITS.has(item.kind) ? 'limits' : 'other';
      g.cats.add(cat);
      if (!isStr(item.result) || !item.result) {
        g.other.push({ kind: item.kind || 'other', text: item.text });
        return;
      }
      const r = g.perResult.get(item.result) || { name: item.result, valueText: '', reasons: [] };
      const v = valueOf(item);
      if (v && !r.valueText) r.valueText = v;
      const reason = shortReason(item);
      if (!r.reasons.some((x) => x.reason === reason))
        r.reasons.push({
          kind: item.kind || 'other',
          reason,
          text: item.text,
          // where a practice range for this result is set (only a "no range to judge" reason carries them)
          ...(item.kind === 'no-range-to-judge' && item.investigationId && item.resultId
            ? {
                setRange: {
                  investigationId: item.investigationId,
                  resultId: item.resultId,
                  labId: item.labId || null,
                  code: item.code || null,
                },
              }
            : {}),
          // the clinical rule that drove this reason, and which of its thresholds fired (a rule has an amber and a red one)
          ...(item.kind === 'clinical-rule' && item.ruleId
            ? {
                rule: {
                  id: item.ruleId,
                  level: item.ruleLevel || null,
                  threshold: item.ruleThreshold == null ? null : item.ruleThreshold,
                  comparator: item.ruleComparator || null,
                  unit: item.ruleUnit || null,
                },
              }
            : {}),
        });
      g.perResult.set(item.result, r);
    };
    items.forEach(placeItem);

    // Every result with a limits reason (a lab flag, a practice range, a clinical rule) can be linked to where its practice range is
    // set: the engine says, for each recognised result it judged, which test and lab that is.
    const owners = asArr(input.owners).filter((o) => o && o.investigationId && o.resultId);
    groups.forEach((g) => {
      g.perResult.forEach((r) => {
        const own = r.reasons.find((x) => x.setRange);
        if (own) r.setRange = own.setRange;
        if (r.setRange || !r.reasons.some((x) => LIMITS.has(x.kind))) return;
        const o = owners.find((x) => normHeading(x.heading) === g.key && normHeading(x.name) === normHeading(r.name));
        if (o)
          r.setRange = {
            investigationId: o.investigationId,
            resultId: o.resultId,
            labId: o.labId || null,
            code: o.code || null,
          };
      });
    });

    // ── unrecognised / whitelisted-pending comments the engine offered, with the whitelist chip data ──────────────
    commentRows.forEach((c) => {
      const g = groups.get(normHeading(c.heading));
      if (!g) return;
      g.comments.push({
        key: c.key,
        name: c.name,
        residue: c.residue,
        labId: c.labId,
        heading: c.heading,
        pending: !!c.pending,
        investigationId: c.investigationId || null,
        undoable: !!(undoable && undoable.has(c.key)),
      });
      g.cats.add(c.pending ? 'comment-pending' : 'comment');
      // The row replaces the bare "carries a comment" per-result line.
      const r = g.perResult.get(c.name);
      if (r) {
        r.reasons = r.reasons.filter((x) => !x.commentLine);
        if (!r.reasons.length) g.perResult.delete(c.name);
      }
    });
    // Only already-whitelisted (awaiting approval) comments left in a group: it is not an UNRECOGNISED comment any more.
    groups.forEach((g) => {
      if (g.comments.length && g.comments.every((c) => c.pending)) g.cats.delete('comment');
    });

    // ── set-up state: attach what the Investigations page needs to open ──────────────────────────────────────────
    setupRows.forEach((s) => {
      const g = groups.get(normHeading(s.heading));
      if (!g) return;
      g.cats.add('setup');
      g.setup = {
        state: s.state || (g.setup && g.setup.state) || 'no-setup',
        text: (g.setup && g.setup.text) || '',
        investigationId: s.investigationId || null,
        label: s.label || null,
      };
    });

    if (labMissing) {
      groups.forEach((g) => {
        if (g.setup) return;
        g.setup = { state: 'no-setup', text: labMissing, investigationId: null, label: null, labMissing: true };
        g.cats.add('setup');
      });
    }

    // The summary says which of the two it is: nothing set up at all, or set up but waiting for a person to approve it.
    groups.forEach((g) => {
      if (!g.setup) return;
      g.cats.delete('setup');
      g.cats.add(g.setup.state === 'no-setup' ? 'setup' : 'setup-awaiting');
    });

    // ── anything the gate raised that no structured item accounts for ────────────────────────────────────────────
    blockers.forEach((b) => {
      if (!covered.has(b)) reportReasons.push({ kind: 'other', text: b });
    });

    const out = [];
    groups.forEach((g) => {
      const results = [...g.perResult.values()].filter((r) => r.reasons.length);
      const summary = SUMMARY_ORDER.filter(([k]) => g.cats.has(k)).map(([, label]) => label);
      const review =
        summary.length > 0 || results.length > 0 || g.comments.length > 0 || !!g.setup || g.other.length > 0;
      const commentOnly = review && [...g.cats].every((c) => c === 'comment' || c === 'comment-pending');
      out.push({
        heading: g.heading,
        key: g.key,
        status: review ? 'review' : 'normal',
        summary,
        chip: commentOnly ? 'show' : 'why',
        results,
        comments: g.comments,
        setup: g.setup,
        other: g.other,
      });
    });
    return {
      total: out.length,
      needReview: out.filter((g) => g.status === 'review').length,
      groups: out,
      reportReasons,
    };
  }

  // ── requests ↔ results ──────────────────────────────────────────────────────────────────────────────────────────
  // requests: the matcher's per-request verdicts as published by content.js (label, name, status, ticked, matchedHeadings…)
  // journal:  the patient's outstanding requests from the record ({ requestedDate, requestedBy, items: [text] })
  // groups:   the matcher's report groups ({ heading, investigationIds, recognisedAs }) — null under the legacy engine
  function buildRequestsView(inp) {
    const input = inp || {};
    const norm =
      typeof input.norm === 'function'
        ? input.norm
        : (t) =>
            String(t || '')
              .trim()
              .toLowerCase();
    const parse = typeof input.parseName === 'function' ? input.parseName : (t) => String(t || '').trim();
    const key = (t) => norm(parse(t));
    const requests = asArr(input.requests).filter(Boolean);
    const journal = asArr(input.journal).filter(Boolean);

    const rows = [];
    const byKey = new Map();
    const statusOf = (v) => {
      if (!v) return 'outstanding';
      if (v.status === 'resulted') return v.ticked ? 'ticked' : 'matched';
      if (v.status === 'resulted_elsewhere') return 'elsewhere';
      return /not in the catalogue|more than one catalogue test/.test(v.reason || '') ? 'unrecognised' : 'outstanding';
    };
    // The page's own request list first — available immediately, long before the record's journal has loaded.
    requests.forEach((v) => {
      const k = key(v.name || v.label);
      if (!k || byKey.has(k)) return;
      const row = {
        label: parse(v.name || v.label),
        sourceLabel: v.label || v.name,
        requestedDate: null,
        requestedBy: null,
        status: statusOf(v),
        headings: asArr(v.matchedHeadings),
        investigationId: v.investigationId || null,
        reason: v.reason || '',
        confidence: v.confidence || null,
      };
      byKey.set(k, row);
      rows.push(row);
    });
    // Then anything else the patient has outstanding (journal) that this task's own list does not carry.
    journal.forEach((inv) => {
      asArr(asArr(inv.items).length ? inv.items : ['Investigation']).forEach((text) => {
        const k = key(text);
        const known = k ? byKey.get(k) : null;
        if (known) {
          if (!known.requestedDate) known.requestedDate = inv.requestedDate || null;
          if (!known.requestedBy) known.requestedBy = inv.requestedBy || null;
          return;
        }
        const row = {
          label: parse(text),
          sourceLabel: text,
          requestedDate: inv.requestedDate || null,
          requestedBy: inv.requestedBy || null,
          status: 'outstanding',
          headings: [],
          investigationId: null,
          reason: '',
          confidence: null,
          fromJournalOnly: true,
        };
        if (k) byKey.set(k, row);
        rows.push(row);
      });
    });

    // Split (Clinician A, 2026-10-04): the top panel is about THIS report — each of its groups, and whether it answers an outstanding
    // request; the bottom panel is every other outstanding request on the patient. A request's status is one of three:
    // resulted here, resulted elsewhere, outstanding. (A request whose wording the suite does not recognise is outstanding,
    // flagged so a card can say why it could not be matched.)
    const answered = (r) => r.status === 'ticked' || r.status === 'matched';
    const elsewhere = rows
      .filter((r) => !answered(r))
      .map((r) => ({
        ...r,
        status: r.status === 'elsewhere' ? 'elsewhere' : 'outstanding',
        wordingNotRecognised: r.status === 'unrecognised',
      }));

    let here = null; // null = no per-group data (legacy engine): the card falls back to one list of every request
    if (Array.isArray(input.groups)) {
      const waiting = rows.filter((r) => r.status === 'outstanding' || r.status === 'unrecognised');
      const unrecognisedRows = rows.filter((r) => r.status === 'unrecognised');
      here = input.groups
        .filter((g) => g && g.heading)
        .map((g) => {
          const gk = normHeading(g.heading);
          const matches = rows.filter((r) => answered(r) && asArr(r.headings).some((h) => normHeading(h) === gk));
          const recognised = asArr(g.recognisedAs).map((x) => x.label);
          // A request is only offered as "possibly this" when it is plausibly the SAME test (its wording shares what makes the test
          // distinctive). A report that is recognised but has no plausible request is usually a copy of a result requested elsewhere —
          // not a wording problem — so nothing is offered then (Clinician A, 2026-10-04: an FBC offered Progesterone Blood).
          const knownNames = asArr(g.recognisedAs).flatMap((x) => (asArr(x.texts).length ? x.texts : [x.label]));
          const plausible = (r) =>
            typeof input.similar !== 'function' || knownNames.some((t) => input.similar(r.label, t) >= 0.5);
          // A request for the very test this group is recognised as, that this report did NOT clear (it post-dates the sample,
          // say) — the reason the matcher gave is the honest explanation, so it is carried through.
          const recognisedIds = asArr(g.recognisedAs).map((x) => x.id);
          const sameTest = rows.filter(
            (r) => !answered(r) && r.investigationId && recognisedIds.includes(r.investigationId)
          );
          let why = null;
          if (!matches.length) {
            why = 'not-recognised';
            if (!rows.length) why = 'no-requests';
            else if (sameTest.length) why = 'recognised-not-cleared';
            else if (recognised.length) why = 'recognised-no-request';
          }
          return {
            heading: g.heading,
            matches,
            matched: matches.length > 0,
            why,
            notCleared:
              why === 'recognised-not-cleared' ? sameTest.map((r) => ({ label: r.label, reason: r.reason })) : [],
            recognisedAs: recognised,
            recognisedIds,
            // EVERY request still waiting, for a person to say "this result answers that request". Never filtered: the suggestion flag
            // (a name that looks alike) only puts likely ones first — it must not stop anyone matching what they know is right.
            requestRows: !why
              ? []
              : waiting
                  .map((r) => ({
                    label: r.label,
                    sourceLabel: r.sourceLabel,
                    investigationId: r.investigationId || null,
                    wordingNotRecognised: r.status === 'unrecognised',
                    suggested:
                      typeof input.similar === 'function' &&
                      [g.heading, ...knownNames].some((t) => input.similar(r.label, t) >= 0.5),
                  }))
                  .sort((a, b) => Number(b.suggested) - Number(a.suggested)),
            // The same candidates as rows, so a card can offer "it is this request" for each (recognised heading, wording not recognised).
            candidateRows:
              why === 'recognised-no-request'
                ? unrecognisedRows.filter(plausible).map((r) => ({ label: r.label, sourceLabel: r.sourceLabel }))
                : [],
            // Requests it might be: when the heading is recognised, only ones whose WORDING is not (that is what keeps
            // it from matching); when it is not, every request still waiting.
            candidates: !why
              ? []
              : why === 'recognised-no-request'
                ? unrecognisedRows.filter(plausible).map((r) => r.label)
                : why === 'not-recognised'
                  ? waiting.map((r) => r.label)
                  : [],
          };
        });
    }
    return { rows, here, elsewhere };
  }

  const api = { buildGroupsView, buildRequestsView, shortReason, normHeading };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.InvestigationResultsView = api;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : global);
