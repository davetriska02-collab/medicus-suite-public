// Medicus Suite — "Investigation results" view model tests (Companion rework, Clinician A, 2026-10-04)
// Run with: node test-investigation-results-view.js
'use strict';

const V = require('./shared/investigation-results-view.js');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  OK  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
    process.exitCode = 1;
  }
}

const row = (name, heading, extra) => ({ name, groupHeading: heading, ...extra });

console.log('\n--- shortReason drops the result name and value ---');
check(
  V.shortReason({ result: 'Haemoglobin', text: 'Haemoglobin (93 g/L) is below your practice minimum of 100' }) ===
    'below your practice minimum of 100',
  'name, value and "is" are stripped'
);
check(
  V.shortReason({ result: 'CRP', text: 'CRP is not within normal limits' }) === 'not within normal limits',
  'a plain "X is not within normal limits"'
);
check(
  V.shortReason({ result: 'MCV', text: 'MCV carries a comment the suite cannot score' }).startsWith(
    'carries a comment'
  ),
  '"carries a comment…" keeps its verb'
);
check(
  V.shortReason({ result: 'Other', text: 'something unrelated' }) === 'something unrelated',
  'a reason not starting with the name is left alone'
);

console.log('\n--- groups: normal groups, and blockers listed per result under their group ---');
{
  const report = {
    results: [
      row('Haemoglobin', 'FBC'),
      row('RBC', 'FBC'),
      row('Sodium', 'U&Es'),
      row('Urea', 'U&Es'),
      row('ALT', 'LFTs'),
    ],
  };
  const items = [
    {
      kind: 'not-within-limits',
      text: 'Haemoglobin (93 g/L) is not within normal limits',
      result: 'Haemoglobin',
      heading: 'FBC',
      covers: ['B1'],
    },
    {
      kind: 'clinical-rule',
      text: 'Haemoglobin (93 g/L) is flagged by the clinical rule "Critical low haemoglobin"',
      result: 'Haemoglobin',
      heading: 'FBC',
      covers: ['B1'],
    },
    {
      kind: 'below-practice-range',
      text: 'Haemoglobin (93 g/L) is below your practice minimum of 100',
      result: 'Haemoglobin',
      heading: 'FBC',
    },
    { kind: 'lab-flagged-abnormal', text: 'RBC is not within normal limits', result: 'RBC', heading: 'FBC' },
  ];
  const v = V.buildGroupsView({ report, items, blockers: ['B1'] });
  check(v.total === 3 && v.needReview === 1, '"1 of 3 groups need review"');
  const fbc = v.groups.find((g) => g.heading === 'FBC');
  check(fbc.status === 'review' && fbc.chip === 'why', 'FBC needs review, with a [why] chip');
  const hb = fbc.results.find((r) => r.name === 'Haemoglobin');
  check(
    hb && hb.valueText === '93 g/L' && hb.reasons.length === 3,
    'Haemoglobin: one entry, value shown once, three reasons'
  );
  check(
    hb.reasons.some((r) => /flagged by the clinical rule/.test(r.reason)) &&
      hb.reasons.some((r) => /practice minimum/.test(r.reason)),
    'the clinical rule and the practice range both appear, without repeating the name'
  );
  check(fbc.results.find((r) => r.name === 'RBC').reasons.length === 1, 'RBC listed with its own reason');
  check(fbc.summary.join() === 'Not within normal limits', 'the row summary says what kind of problem it is');
  check(
    v.groups
      .filter((g) => g.status === 'normal')
      .map((g) => g.heading)
      .join() === 'U&Es,LFTs',
    'U&Es and LFTs are "all in normal limits"'
  );
  check(v.reportReasons.length === 0, 'nothing left over: B1 is covered');
}

console.log('\n--- nothing is ever dropped ---');
{
  const report = { results: [row('Sodium', 'U&Es')] };
  const v = V.buildGroupsView({
    report,
    items: [{ kind: 'report', text: 'this report is not matched to a patient', result: null, heading: null }],
    blockers: [
      'this report is not matched to a patient',
      'the Lab Result Catalogue could not be checked — file manually',
    ],
  });
  check(
    v.reportReasons.some((r) => /not matched to a patient/.test(r.text)),
    'a report-wide item lands in reportReasons'
  );
  check(
    v.reportReasons.some((r) => /could not be checked/.test(r.text) && r.kind === 'other'),
    'a blocker no structured item covers is appended as kind "other" — never silently lost'
  );
  const u = V.buildGroupsView({
    report,
    items: [
      {
        kind: 'unrecognised-code',
        text: "Mystery (code 1) is not one of the catalogue's known results",
        result: 'Mystery',
        heading: 'Nowhere',
      },
    ],
    blockers: [],
  });
  check(u.reportReasons.length === 1, 'an item for a heading the report does not have is not discarded either');
  const noGroup = V.buildGroupsView({
    report,
    items: [{ kind: 'other', text: 'Sodium has something odd', result: 'Sodium', heading: null }],
    blockers: [],
  });
  check(noGroup.groups[0].status === 'review', "a result-only item is placed in that result's group");
  check(
    V.buildGroupsView({ report: { results: [] }, items: [], blockers: ['x'] }).reportReasons.length === 1,
    'an empty report still reports its blockers'
  );
}

console.log('\n--- comments: unrecognised, whitelisted-awaiting-approval, and the chip label ---');
{
  const report = { results: [row('MCV', 'FBC'), row('Sodium', 'U&Es')] };
  const items = [
    {
      kind: 'comment-not-whitelisted',
      text: "MCV carries a comment that isn't on the allowed list (“Note new reference ranges”)",
      result: 'MCV',
      heading: 'FBC',
    },
  ];
  const rows = [
    { key: 'k1', name: 'MCV', residue: 'Note new reference ranges', labId: 'lab1', heading: 'FBC', pending: false },
  ];
  const v = V.buildGroupsView({ report, items, comments: rows, blockers: [items[0].text], undoable: new Set() });
  const fbc = v.groups[0];
  check(
    fbc.chip === 'show' && fbc.summary.join() === 'Unrecognised comment',
    'comment-only group: "Unrecognised comment" with a [show] chip'
  );
  check(
    fbc.comments.length === 1 &&
      fbc.comments[0].residue === 'Note new reference ranges' &&
      fbc.comments[0].undoable === false,
    'the comment is listed with its whitelist data'
  );
  check(fbc.results.length === 0, 'no duplicate per-result "carries a comment" line when the comment itself is listed');

  const pend = V.buildGroupsView({
    report,
    items: [],
    comments: [
      {
        key: 'k1',
        name: 'MCV',
        residue: 'Note new reference ranges',
        labId: 'lab1',
        heading: 'FBC',
        pending: true,
        investigationId: 'fbc',
      },
    ],
    blockers: [],
    undoable: new Set(['k1']),
  });
  check(
    pend.groups[0].summary.join() === 'Whitelisted comment not approved',
    'an already-whitelisted comment reads "not approved", not "unrecognised"'
  );
  check(
    pend.groups[0].comments[0].undoable === true && pend.groups[0].comments[0].investigationId === 'fbc',
    'undo offered when this session saved it; approve link carried'
  );

  const mixed = V.buildGroupsView({
    report,
    items: [{ kind: 'lab-flagged-abnormal', text: 'MCV is not within normal limits', result: 'MCV', heading: 'FBC' }],
    comments: [{ key: 'k1', name: 'MCV', residue: 'Note', labId: 'lab1', heading: 'FBC', pending: false }],
    blockers: [],
  });
  check(mixed.groups[0].chip === 'why', 'a group with a comment AND another problem uses [why], not [show]');

  const legacy = V.buildGroupsView({
    report,
    items: [
      {
        kind: 'comment',
        text: 'MCV carries a comment the suite cannot score',
        result: 'MCV',
        heading: 'FBC',
        residue: 'x',
      },
    ],
    blockers: [],
  });
  check(
    legacy.groups[0].results[0] && /carries a comment/.test(legacy.groups[0].results[0].reasons[0].reason),
    'with no whitelist row (legacy path) the per-result line still tells you'
  );
}

console.log('\n--- set-up state: no setup, awaiting approval ---');
{
  const report = { results: [row('Osmolality', 'Urine osmolality'), row('Sodium', 'U&Es')] };
  const v = V.buildGroupsView({
    report,
    items: [
      {
        kind: 'group-not-approved',
        text: '‘Urine osmolality’ has no approved assisted-filing setup at X',
        heading: 'Urine osmolality',
        state: 'test-awaiting-approval',
      },
    ],
    setups: [
      {
        heading: 'Urine osmolality',
        investigationId: 'urine-osm',
        label: 'Urine osmolality',
        state: 'test-awaiting-approval',
      },
    ],
    blockers: [],
  });
  const g = v.groups[0];
  check(
    g.status === 'review' &&
      g.setup &&
      g.setup.investigationId === 'urine-osm' &&
      g.setup.state === 'test-awaiting-approval',
    'the set-up state and the test to open are carried'
  );
  check(g.summary.join() === 'Awaiting approval', 'and it is summarised as awaiting approval (not "not set up")');
}

console.log('\n--- requests: results in THIS report on top, every other outstanding request beneath ---');
{
  const norm = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const parse = (t) =>
    String(t || '')
      .replace(/\s*\(.*$/, '')
      .trim();
  const requests = [
    {
      label: 'Urea and Electrolytes (Dr A • 29 Sep)',
      name: 'Urea and Electrolytes',
      status: 'resulted',
      ticked: true,
      matchedHeadings: ['U&Es'],
      investigationId: 'ue',
    },
    {
      label: 'eGFR (Dr A • 29 Sep)',
      name: 'eGFR',
      status: 'resulted',
      ticked: false,
      matchedHeadings: ['U&Es'],
      investigationId: 'egfr',
    },
    {
      label: 'Bone Profile (Dr A • 30 Sep)',
      name: 'Bone Profile',
      status: 'outstanding',
      investigationId: 'bone',
      reason: 'request post-dates the sample — a later request, still outstanding',
    },
    {
      label: 'Full Blood Count (Dr A)',
      name: 'Full Blood Count',
      status: 'outstanding',
      reason: 'request test not in the catalogue — left for manual review',
    },
    { label: 'Lipids (Dr A)', name: 'Lipids', status: 'resulted_elsewhere' },
  ];
  // The report carries U&Es, FBC, Bone and Amylase. (investigationIds are what the catalogue recognises the group as — not
  // whether any REQUEST is answered, which is what decides matched / unmatched.)
  const groups = [
    { heading: 'U&Es', investigationIds: ['ue', 'egfr'], recognisedAs: [{ id: 'ue', label: 'U&E' }] },
    { heading: 'FBC', investigationIds: ['fbc'], recognisedAs: [{ id: 'fbc', label: 'Full blood count' }] },
    { heading: 'Bone profile', investigationIds: ['bone'], recognisedAs: [{ id: 'bone', label: 'Bone profile' }] },
    { heading: 'Amylase', investigationIds: [], recognisedAs: [] },
  ];
  const v = V.buildRequestsView({ requests, journal: [], groups, norm, parseName: parse });
  check(v.here.length === 4, 'one row per report group, in report order');
  const ues = v.here.find((g) => g.heading === 'U&Es');
  check(ues.matched && ues.matches.length === 2, 'U&Es matched: it answers TWO requests');
  check(
    ues.matches[0].status === 'ticked' && ues.matches[1].status === 'matched',
    'one ticked, one matched but not ticked'
  );
  const bone = v.here.find((g) => g.heading === 'Bone profile');
  check(
    !bone.matched && bone.why === 'recognised-not-cleared' && /post-dates/.test(bone.notCleared[0].reason),
    'Bone profile: there is a request for it but this report did not clear it, and the matcher reason is carried through'
  );
  const fbc = v.here.find((g) => g.heading === 'FBC');
  check(
    !fbc.matched && fbc.why === 'recognised-no-request' && fbc.candidates.join() === 'Full Blood Count',
    'FBC recognised but its request wording is not: the unrecognised request is offered as the likely one'
  );
  check(
    fbc.recognisedIds.join() === 'fbc' &&
      fbc.candidateRows.length === 1 &&
      fbc.candidateRows[0].label === 'Full Blood Count',
    'and it carries the recognised test id and the candidate request rows, so the card can offer "it is this request"'
  );
  check(
    bone.candidateRows.length === 0,
    'a group with a request that merely was not cleared (not a wording problem) offers no wording match'
  );
  const amy = v.here.find((g) => g.heading === 'Amylase');
  check(
    amy.why === 'not-recognised' && amy.candidates.length === 2,
    'Amylase: not recognised, with the requests still waiting (not the one resulted elsewhere) as candidates'
  );
  check(
    v.elsewhere.every((r) => !['ticked', 'matched'].includes(r.status)),
    'the lower list never contains a request this report answered'
  );
  check(
    v.elsewhere.map((r) => r.status).join() === 'outstanding,outstanding,elsewhere',
    'its statuses are only outstanding or resulted elsewhere'
  );
  check(
    v.elsewhere.find((r) => r.label === 'Full Blood Count').wordingNotRecognised === true,
    'an unrecognised wording is flagged, not given a fourth status'
  );
  check(v.elsewhere.length === 3 && v.rows.length === 5, 'every request is in exactly one place');

  const none = V.buildRequestsView({ requests: [], journal: [], groups, norm, parseName: parse });
  check(
    none.here.every((g) => g.why === 'no-requests'),
    'no open requests at all is reported as that, not as a fault'
  );
  const legacy = V.buildRequestsView({ requests, journal: [], groups: null, norm, parseName: parse });
  check(
    legacy.here === null && legacy.elsewhere.length === 3,
    'under the legacy engine (no group data) there is no per-group list, and nothing is claimed'
  );
  const withJournal = V.buildRequestsView({
    requests,
    journal: [{ requestedDate: '29 Sep 2026', requestedBy: 'Dr A', items: ['Urea and Electrolytes', 'Lipids Blood'] }],
    groups,
    norm,
    parseName: parse,
  });
  check(withJournal.rows.length === 6, 'the journal adds requests this task does not list, without duplicating');
  check(withJournal.rows[0].requestedDate === '29 Sep 2026', 'and fills in dates on ones it already has');
  check(
    withJournal.elsewhere.some((r) => r.fromJournalOnly && r.status === 'outstanding'),
    'a journal-only request is outstanding'
  );
  const early = V.buildRequestsView({ requests, journal: [], groups, norm, parseName: parse });
  check(early.rows.length === 5, 'rows exist before the journal has arrived');
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
