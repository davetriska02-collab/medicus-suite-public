// test-request-monitor-inbox.js — Use the inbox open in Medicus.
// The scan is pure (no DOM, no storage). It only fills a field when the
// caller asks it to. Run with: node test-request-monitor-inbox.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  OK  ' + msg);
    passed++;
  } else {
    console.error('  FAIL  ' + msg);
    failed++;
  }
}

const optionsJs = fs.readFileSync(path.join(__dirname, 'options/options.js'), 'utf8');
const optionsHtml = fs.readFileSync(path.join(__dirname, 'options/options.html'), 'utf8');
const hazard = fs.readFileSync(path.join(__dirname, 'docs/HAZARD-LOG.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');

const start = optionsJs.indexOf('const UUID_RE = ');
const end = optionsJs.indexOf('function clearRmInboxChoices()');
assert(start > 0 && end > start, 'pure inbox-scan block is in options.js');
const chunk = optionsJs.slice(start, end);
const sandbox = { URL, URLSearchParams };
vm.runInNewContext(
  chunk +
    [
      'this.extractAssigneeId = extractAssigneeId;',
      'this.isMedicusTaskListUrl = isMedicusTaskListUrl;',
      'this.assigneeIdFromOpenInboxUrl = assigneeIdFromOpenInboxUrl;',
      'this.scanMedicusInboxTabs = scanMedicusInboxTabs;',
      'this.inboxFillCaution = inboxFillCaution;',
      'this.inboxChooseMessage = inboxChooseMessage;',
      'this.inboxChoiceCaption = inboxChoiceCaption;',
      'this.RM_INBOX_NONE_GUIDANCE = RM_INBOX_NONE_GUIDANCE;',
      'this.RM_INBOX_CAUTION = RM_INBOX_CAUTION;',
    ].join('\n'),
  sandbox
);

const TEAM = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const RESULTS = '33333333-3333-4333-8333-333333333333';

function taskList(slug, assignee, extra) {
  let q = '';
  if (assignee) q = 'masterAssignee=' + assignee;
  if (extra) q = q ? q + '&' + extra : extra;
  return 'https://england.medicus.health/a1b2c3/tasks/' + slug + '/task-list' + (q ? '?' + q : '');
}

console.log('\n--- single open task list ---');
const one = sandbox.scanMedicusInboxTabs([
  {
    url: taskList('medical_patient_request_task', TEAM.toUpperCase()),
    title: 'Triage Doctor - Medicus',
  },
  { url: 'https://england.medicus.health/a1b2c3/home', title: 'Home - Medicus' },
]);
assert(one.status === 'one', 'one task-list tab is a single fill');
assert(one.assigneeId === TEAM, 'assignee is lowercased through extractAssigneeId');
assert(
  one.assigneeId === sandbox.extractAssigneeId('masterAssignee=' + TEAM.toUpperCase()),
  'scan id matches extractAssigneeId on the masterAssignee fragment'
);
assert(one.label.indexOf('Triage Doctor') !== -1, 'tab title is kept as the filter label');
assert(one.label.indexOf('Medical requests') !== -1, 'queue slug on the URL is shown');
assert(one.candidates.length === 1, 'one candidate');

console.log('\n--- none ---');
const none = sandbox.scanMedicusInboxTabs([
  { url: 'https://england.medicus.health/a1b2c3/home', title: 'Home' },
  { url: taskList('medical_patient_request_task', ''), title: 'Medical requests' },
  {
    url: 'https://example.com/tasks/medical_patient_request_task/task-list?masterAssignee=' + TEAM,
    title: 'Not Medicus',
  },
]);
assert(none.status === 'none', 'no task-list masterAssignee means none');
assert(none.assigneeId === '', 'none does not invent an assignee');
assert(none.candidates.length === 0, 'none has no candidates');
assert(sandbox.scanMedicusInboxTabs(null).status === 'none', 'null tab list is none');
assert(sandbox.scanMedicusInboxTabs([]).status === 'none', 'empty tab list is none');

console.log('\n--- non-task-list URLs are ignored ---');
const patient = 'https://england.medicus.health/a1b2c3/clinical/patient/' + PERSON + '/overview';
const homepageFilter =
  'https://england.medicus.health/a1b2c3/tasks/medical_patient_request_task?masterAssignee=' + TEAM;
const otherUuid = taskList('medical_patient_request_task', '') + '?patientId=' + RESULTS;
assert(sandbox.isMedicusTaskListUrl(patient) === false, 'patient record is not a task list');
assert(sandbox.assigneeIdFromOpenInboxUrl(patient) === '', 'patient UUID is not an inbox');
assert(sandbox.isMedicusTaskListUrl(homepageFilter) === false, 'a tasks URL without /task-list is not a task list');
assert(sandbox.assigneeIdFromOpenInboxUrl(homepageFilter) === '', 'masterAssignee off a task-list URL is ignored');
assert(sandbox.assigneeIdFromOpenInboxUrl(otherUuid) === '', 'a task-list UUID that is not masterAssignee is ignored');
const ignored = sandbox.scanMedicusInboxTabs([
  { url: patient, title: 'Clinician A - Medicus' },
  { url: homepageFilter, title: 'Triage Doctor' },
  { url: otherUuid, title: 'Medical requests' },
]);
assert(ignored.status === 'none', 'non-task-list and non-masterAssignee tabs do not fill');

console.log('\n--- several conflicting inboxes ---');
const many = sandbox.scanMedicusInboxTabs([
  {
    url: taskList('medical_patient_request_task', TEAM, 'assigneeName=Triage%20Doctor'),
    title: 'Medical requests - Medicus',
  },
  {
    url: taskList('review_investigation_results_task', RESULTS),
    title: 'Results - Medicus',
  },
  {
    url: taskList('admin_patient_request_task', PERSON),
    title: 'Clinician A - Medicus',
  },
]);
assert(many.status === 'many', 'different masterAssignee values are not collapsed');
assert(many.assigneeId === '', 'a conflict does not pick an assignee');
assert(many.candidates.length === 3, 'each distinct inbox is listed');
assert(
  many.candidates.map((c) => c.assigneeId).join(',') === [TEAM, RESULTS, PERSON].join(','),
  'candidates stay in tab order'
);
assert(many.candidates[0].label.indexOf('Triage Doctor') !== -1, 'URL filter name is shown');
assert(many.candidates[1].label.indexOf('Results') !== -1, 'Results tab title is shown');
assert(many.candidates[1].label.indexOf('Investigation results') !== -1, 'results queue label is shown');
assert(many.candidates[2].label.indexOf('Clinician A') !== -1, 'personal inbox title is shown');
const captions = many.candidates.map((c) => sandbox.inboxChoiceCaption(c, many.candidates));
assert(captions[0].indexOf('Triage Doctor') !== -1, 'choice caption uses the filter label');
assert(
  /not your personal inbox or Results/.test(sandbox.inboxFillCaution('Triage Doctor')),
  'caution names the wrong inboxes'
);
assert(
  /Nothing is saved until you press Save monitor settings/.test(sandbox.inboxFillCaution('')),
  'caution says save is still required'
);
assert(/Filled from Triage Doctor/.test(sandbox.inboxFillCaution('Triage Doctor')), 'caution names the filled filter');
assert(/close the other tabs/.test(sandbox.inboxChooseMessage()), 'chooser tells the person they can close tabs');
assert(
  sandbox.RM_INBOX_NONE_GUIDANCE ===
    'Open the task list in Medicus with your triage team filter (e.g. Triage Doctor) applied, then try again.',
  'empty-state guidance is the agreed sentence'
);

console.log('\n--- same assignee on two tabs is one fill ---');
const same = sandbox.scanMedicusInboxTabs([
  { url: taskList('medical_patient_request_task', TEAM), title: 'Triage Doctor - Medicus' },
  { url: taskList('admin_patient_request_task', TEAM), title: 'Triage Doctor - Medicus' },
]);
assert(same.status === 'one', 'the same masterAssignee is one inbox');
assert(same.assigneeId === TEAM, 'shared assignee is the fill value');

console.log('\n--- hash-routed task list ---');
const hashed = sandbox.scanMedicusInboxTabs([
  {
    url:
      'https://england.medicus.health/a1b2c3/#/tasks/medical_patient_request_task/task-list?masterAssignee=' + PERSON,
    title: 'Clinician A',
  },
]);
assert(hashed.status === 'one' && hashed.assigneeId === PERSON, 'hash task-list masterAssignee is read');

console.log('\n--- button is fill-only ---');
function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) return '';
  const brace = src.indexOf('{', at);
  let depth = 0;
  let quote = '';
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}
const filler = extractFunction(optionsJs, 'fillAssigneeFromOpenMedicusTabs');
assert(filler.indexOf('function fillAssigneeFromOpenMedicusTabs') === 0, 'filler function extracted');
assert(
  /chrome\.tabs\.query\(\{\s*url:\s*'https:\/\/\*\.medicus\.health\/\*'/.test(filler),
  'filler queries Medicus tabs'
);
assert(filler.indexOf('scanMedicusInboxTabs(') !== -1, 'filler uses the scan');
assert(!/chrome\.storage/.test(filler), 'filler does not touch storage');
assert(!/setConfig/.test(filler), 'filler does not save monitor settings');
assert(!/RequestMonitor/.test(filler), 'filler does not call Request Monitor');
const fieldFill = extractFunction(optionsJs, 'fillRmAssigneeFromInbox');
assert(/rmAssigneeId\.value\s*=/.test(fieldFill), 'a chosen inbox writes the field');
assert(!/setConfig/.test(fieldFill), 'writing the field does not save');
assert(!/chrome\.storage/.test(fieldFill), 'writing the field does not touch storage');
assert(optionsJs.indexOf('RequestMonitor.setConfig') !== -1, 'Save monitor settings still writes config');
assert(/id="rmUseOpenInbox"/.test(optionsHtml), 'options page has the button');
assert(/Use the inbox open in Medicus/.test(optionsHtml), 'button label is on the page');
assert(
  /type="button"[\s\S]{0,80}id="rmUseOpenInbox"|id="rmUseOpenInbox"[\s\S]{0,40}type="button"/.test(optionsHtml) ||
    /<button type="button" class="ghost rm-inbox-btn" id="rmUseOpenInbox"/.test(optionsHtml),
  'button is type=button'
);
assert(/aria-live="polite"/.test(optionsHtml), 'inbox note is a polite live region');
assert(/id="rmAssigneeHelp"/.test(optionsHtml), 'help text has an id');
assert(/does not save/.test(optionsHtml), 'help text says the button does not save');
assert(/Save monitor settings/.test(optionsHtml), 'help text still points at Save');

console.log('\n--- hazard log H-045 addendum ---');
assert(manifest.version === '4.0.0', 'manifest is 4.0.0 (next release after 3.269.6)');
assert(/^## \[v4\.0\.0\]/m.test(changelog), 'changelog opens at 4.0.0');
assert(/^\*\*Document version:\*\* 3\.110/m.test(hazard), 'hazard-log document version is 3.110');
assert(/\*\*Product version:\*\* 4\.0\.0/.test(hazard), 'product pin is 4.0.0');
const h045 = hazard.split('### H-045 —')[1].split('### H-046 —')[0];
assert(!/UNSIGNED/.test(h045), 'H-045 addendum is signed');
assert(/Dr D\. Triska, CSO, GMC 6159481, 6 Oct 2026/.test(h045), 'H-045 addendum is signed by Dr D. Triska');
assert(/Accepted \(ALARP\)/.test(h045), 'H-045 addendum is Accepted (ALARP)');
assert(/residual 3/.test(h045), 'H-045 addendum residual stays 3');
assert(/wrong inbox/.test(h045), 'H-045 names the wrong-inbox cause');
assert(/under-reports/.test(h045), 'H-045 names under-reporting');
assert(/Fill only/.test(h045), 'H-045 records fill-only');
assert(/does not save/.test(h045), 'H-045 records explicit save');
assert(/does not guess/.test(h045), 'H-045 records multi-tab disambiguation');
assert(/inline caution/.test(h045), 'H-045 records the inline caution');
assert(/bare UUID/.test(h045), 'H-045 records manual paste');
const h046 = hazard.split('### H-046 —')[1].split('### H-047 —')[0];
assert(h046.indexOf('Use the inbox open in Medicus') === -1, 'H-046 is unchanged');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
