# Lite build scope — monitoring rules and calculators

**Status:** superseded. This branch is the next main release, manifest `4.0.0`, not a side build. The sections below are the earlier inventory. They are not the current product.  
**Branch:** `lite/no-monitoring-calculators` (off `main` at v3.269.6).  
**Decision (superseded):** the first cut kept QOF. The wider cut removes every derived clinical judgement, recommendation and calculation from the product path, including QOF, vaccines, allergy and interaction prompts, red-flag chips, result interpretation, assisted filing, and dosing hints. When a surface was borderline it was removed and listed in the pull request. Build the zip with `sh scripts/build-lite-zip.sh`. That script does not tag or publish. The sections below are the original narrower scope and are not the current product behaviour.

An earlier draft of this branch used manifest `9.0.0` and the name Medicus Suite Lite. That draft is withdrawn. The branch is now manifest `4.0.0`, the next release after 3.269.6. Do not tag it.

`release.yml` publishes a GitHub release when `main` is pushed and when a `v*` tag is pushed. This branch does neither.

## Call on QOF

QOF stays.

`rules/qof-rules.json` is not the drug-monitoring engine. `engine/rules-engine.js` evaluates it with `evaluateQofRegisterRule` and `evaluateQofIndicatorRule`. Drug-interval rules use `evaluateDrugRule`. The two share `evaluatePatient`, the chip renderer, and several screens, which is why deleting the engine file would take QOF with it. Keeping the file and the QOF evaluators leaves QOF in place.

The file currently holds 89 rules: 16 `qof-register` and 73 `qof-indicator`.

Five of those indicator rules are labelled `category: "safety-monitoring"` and are clinical-review prompts, evaluated on the QOF-indicator path:

| id | indicatorCode | What it checks |
|---|---|---|
| `trend-egfr-falling` | TREND-EGFR | Falling recorded eGFR trend |
| `alert-hyperkalaemia` | K-HIGH | High potassium |
| `trend-hba1c-rising` | TREND-HBA1C | Rising HbA1c trend |
| `qof-ckd002` | CKD-BP | BP in CKD. The file notes this is not a QOF 26/27 claim indicator |
| `qof-ckd003` | CKD-RASI | RASI in CKD, same non-claim framing |

They read a recorded lab value. They do not calculate eGFR, CHA2DS2-VASc, or QRISK. They stay with QOF under this call. A later cut that treats `category: "safety-monitoring"` as monitoring would have to lift these five out of the QOF file without dropping the claim indicators around them.

CHA2DS2-VASc in this file is the same kind of lookup. `qof-af006` (recorded score in 12 months) and `qof-af008` (anticoagulant where a recorded score is at least 2) match a stored observation. The rule notes state that the suite does not calculate the score. Those two rules stay with QOF.

## What counts as a monitoring rule

A monitoring rule here is a rule whose type is `drug-monitoring` or `drug-no-monitoring`, plus shipped alerts of type `drug-monitoring`, plus the chips and screens that exist to show that output.

These are separate engines and stay:

| Path | Why it stays |
|---|---|
| `rules/qof-rules.json` | QOF registers and indicators. See the call above |
| `rules/vaccine-rules.json` | Vaccine due/given. `evaluateVaccineRule` |
| `rules/reception-pathways.json` | Reception capture pathways |
| `engine/result-rules.js`, `engine/result-severity.js` | Investigation-result threshold chips (`.ch-q-result`). Different engine from drug-monitoring |
| `rules/lab-catalogue.json`, `rules/lab-code-info.json` | Lab analyte catalogue. An eGFR row is a recorded test, not an eGFR equation |
| `rules/alert-library.json` entries whose `rule.type` is `drug-combo`, `event-count`, `composite`, or `qof-indicator` | Prescribing-safety and other alerts. They share the library file with five monitoring alerts; they are not interval-monitoring rules |

`rules/drug-rules.json` also holds four `drug-allergy` rules. Those are allergy conflicts, not interval monitoring. Deleting the file would remove them too. A clean cut has to split the file.

## Monitoring rules — `rules/drug-rules.json`

43 rules. 37 enabled `drug-monitoring`, 1 disabled `drug-monitoring`, 1 `drug-no-monitoring`, 4 `drug-allergy`.

Enabled `drug-monitoring`:

`methotrexate-maintenance`, `leflunomide-maintenance`, `hydroxychloroquine-maintenance`, `azathioprine-maintenance`, `sulfasalazine-maintenance`, `carbamazepine-maintenance`, `lithium-maintenance`, `amiodarone-maintenance`, `carbimazole-propylthiouracil`, `ace-arb`, `spironolactone`, `sglt2-inhibitor`, `glp1-receptor-agonist`, `doac`, `statin`, `allopurinol`, `antipsychotic`, `mirabegron`, `levothyroxine`, `hrt-systemic`, `adhd-stimulant-paediatric`, `adhd-stimulant-adult`, `atomoxetine-maintenance`, `guanfacine-maintenance`, `sodium-valproate`, `finerenone`, `warfarin-vka`, `mycophenolate-maintenance`, `ciclosporin-maintenance`, `tacrolimus-systemic`, `mercaptopurine-maintenance`, `cenobamate-lft`, `fezolinetant-lft`, `thiazide-diuretic-ue`, `denosumab-calcium`, `dmpa-injectable`, `chc-combined-hormonal`.

Disabled `drug-monitoring`: `digoxin-renal-monitoring` (`enabled: false`).

`drug-no-monitoring`: `no-monitoring-common`. The coverage view uses this list so common drugs are not reported as unmatched. It is part of the monitoring engine.

`drug-allergy` (not monitoring; would be lost if the file were deleted): `allergy-penicillin`, `allergy-penicillin-cephalosporin-xs`, `allergy-nsaid`, `allergy-sulfonamide`.

## Monitoring alerts — `rules/alert-library.json`

39 library entries. Five are `rule.type: "drug-monitoring"` and depend on `evaluateDrugRule`:

| libId | Custom rule id | Title |
|---|---|---|
| `pincer-7` | `custom-pincer-7-warfarin-inr` | Warfarin without recent INR |
| `pincer-9` | `custom-pincer-9-metformin-renal` | Metformin without recent renal function |
| `pincer-10` | `custom-pincer-10-loop-diuretic-ue` | Loop diuretic without recent U&E |
| `pincer-11` | `custom-pincer-11-amiodarone-monitoring` | Amiodarone without TFT/LFT |
| `nice-lithium-monitoring` | `custom-nice-lithium-monitoring` | Lithium without level and U&E/TFT |

The other 34 are not interval-monitoring rules: 30 `drug-combo` (PINCER combinations, MHRA pregnancy-prevention and interaction alerts), 2 `event-count`, 1 `composite`, 1 `qof-indicator` (`trend-1`, rising PSA). They stay unless a later cut widens "monitoring" to every PINCER entry. Live PINCER false-negatives are already one hazard class with drug-monitoring (H-016), so that widening is a product decision, not a file boundary.

Practice-authored rules of type `drug-monitoring` live in `chrome.storage.local` under `sentinel.customRules`. They are created in `sentinel-options/options.js` and travel in the `sentinel` backup scope (`shared/io/sentinel-io.js`). A build that only empties the JSON file leaves those stored rules active, and a restore of a full-suite backup puts them back.

## Monitoring engine and everything that imports it

The evaluator is not its own package. It is `evaluateDrugRule` inside `engine/rules-engine.js` (loaded from `manifest.json` content scripts and from `content-scripts/sentinel.js`). `evaluatePatient` defaults a missing `type` to `drug-monitoring`.

Loaders of `rules/drug-rules.json`:

| Path | Role |
|---|---|
| `content-scripts/sentinel.js` | Merges drug rules with QOF rules for the open patient |
| `content-scripts/triage-lens/content.js` (`loadMonitoringRules`, `selectMonitoringDue`, `injectMonitoringChip`) | Record/detail monitoring-due chip and queue `.ch-q-mon` chips |
| `content-scripts/rx-overdue-scan.js` | Overdue scan on prescription lists. Also loads QOF |
| `options/options.js` | Rules-currency card and the rules browser ("Drug monitoring rules") |
| `scripts/check-rule-currency.js` | Currency check over the bundled files |

Surfaces that filter or rank `type === 'drug-monitoring'` chips. QOF and vaccine chips are produced in the same pass, so these files cannot be deleted:

| Path | What breaks if drug-monitoring output disappears without a filter |
|---|---|
| `side-panel/modules/sentinel/sentinel.js`, `sentinel-core.js`, `coverage-core.js`, `brief-core.js`, `passport-core.js` | Monitoring tab, unmatched-meds coverage, huddle brief, passport. QOF chips on the same tab would remain only if the rule list is filtered, not if the module is removed |
| `side-panel/modules/signing/signing.js`, `signing-core.js` | Signing queue rank is defined only on drug-monitoring chips. With none, every row falls through to "no monitoring flags recorded". The screen already prints a "not all clear" caveat (H-038). The rank order that the queue exists for would be gone |
| `side-panel/modules/sweep/sweep.js`, `sweep-core.js` | Pre-clinic worklist and handout. Bloods/checks are the drug-monitoring chips |
| `side-panel/modules/shared/action-packs.js` | Blood-form pack is built from drug-monitoring chips |
| `content-scripts/task-actions-panel.js` | Companion "What's due" pocket. It renders the Sentinel brief, which leads with drug-monitoring and also shows QOF and vaccine |
| `shared/checkin-prompts.js` | Check-in prompt priority: overdue/stale drug-monitoring outranks vaccine and QOF |
| `shared/chip-renderer.js` | `renderDrugChip` and the drug-monitoring branch of the shared renderer |
| `shared/stackchan-bridge.js` | Optional desk-robot face from worst Sentinel chip status. QOF/vaccine statuses would still drive it if those chips remain |
| `side-panel/panel.js`, `pop-out/pop-out.js`, `side-panel/tab-catalog.js`, `side-panel/tour/tour-steps.js` | Nav entry, help text, and tour copy for the Monitoring tab |
| `sentinel-options/options.html`, `sentinel-options/options.js` | Custom-rule builder. Drug-monitoring is a first-class type (`crList`), alongside QOF, drug-combo, event-count, and composite |
| `options/options.html` | "Drug monitoring chips — always shown." There is no off switch. Monitoring settings are the Sentinel section |
| `shared/io/sentinel-io.js` | Backup keys: `sentinel.config`, `sentinel.rules`, `sentinel.orgRules`, `sentinel.customRules`, `sentinel.alertLibrary.acknowledged`, `sentinel.hiddenRules`, `sentinel.briefCollapsed` |
| `shared/io/suite-envelope.js` | Scope `sentinel` is in `VALID_SCOPES`. Preview warns when a backup disables monitoring rules |
| `shared/io/practice-profile.js` | Practice profile can push the `sentinel` module (rules, custom rules, config). Default module set includes `sentinel` |

Queue chip mechanics that must stay intact for the chips that are not monitoring: age/decoration (`.ch-queue-chips`) and result triage (`.ch-q-result`) are injected in the same `content.js` refresh path as `.ch-q-mon`. That file prepends foreign nodes because the Medicus page strips trailing ones. A partial edit that breaks re-injection takes the result chips with the monitoring chips.

## Calculators

There is no calculators module, tab, or `rules/*calculator*` file. The suite's own safety docs say the QRISK3 / QCancer / eFI chip is a link list and that no score is computed. The Patient Record Visualiser, which did compute an eFI, was removed at v3.255.0. H-015 (eFI inaccuracy) is retired with it. No live eFI equation was found.

What does compute a number, and where it sits:

| Computation | Path | Consumers | Separable? |
|---|---|---|---|
| Anticholinergic burden (ACB) | `engine/acb-scores.js` (`computeACB`, `ACB_TABLE`) | `manifest.json` content script; `pop-out/pop-out.html`; `content-scripts/triage-lens/content.js` (single scorer; must not keep its own table); `side-panel/modules/record/record.js`; `side-panel/modules/record/smr-pack-core.js`; `engine/stopp-start.js` (anticholinergic criterion reads `ACB_TABLE`) | No. Removing the file breaks STOPP's anticholinergic criterion and the record/queue score. STOPP itself (`engine/stopp-start.js`) is a prescribing-flag engine that reads a recorded eGFR. It is not an eGFR calculator. It is the live surface named in H-016 and H-019 |
| Cockcroft-Gault creatinine clearance | `side-panel/modules/trends/doac-core.js` (`cockcroftGault`) | `side-panel/modules/trends/trends.js` DOAC view and CrCl chart. KDIGO `gStage` / `aStage` in `trends.js` only band a recorded eGFR or ACR | No. Trends also charts BP, HbA1c, cholesterol, and weight, which are plots of recorded values. CrCl is one function inside that tab |
| HRT gel quantity / days | `rules/hrt-gram-dose-factors.json` | `shared/repeat-authorisation.js`; `content-scripts/repeat-prescribing-pills.js`; listed in `manifest.json` `web_accessible_resources` | No. It is a dosing table inside the repeat-authorisation pill (H-076), not a screen that can be unlisted |
| Risk-tool signpost | `content-scripts/triage-lens/content.js` (`record.riskScores` when age is known and at least 25) | System chip. Links out. Computes nothing | The chip can be removed on its own. The links are the only QRISK-style surface |
| Frailty signature | same `content.js` `computeSignals` | Counts recent problems whose names match frailty terms | A count of coded problems, not an eFI. Leave it unless "risk scores" is widened to include it |
| CHA2DS2-VASc | `rules/qof-rules.json` `qof-af006`, `qof-af008`; matching in `engine/rules-engine.js` | QOF chips | Not a calculator. Stays with QOF |
| eGFR equation (CKD-EPI / MDRD) | none found | Lab catalogue stores the analyte. STOPP, drug rules, and Trends consume a recorded number | Nothing to delete |
| Rota Bradford factor | `rota/engine/bradford.js` | Rota staffing metric | Out of scope. It is not a clinical calculator |

## Tests that pin the removed behaviour

These fail if the rules or calculators are deleted or emptied without rewriting the tests:

`test-drug-brand-coverage.js`, `test-drug-monitoring-dedup.js`, `test-drug-matched-term.js`, `test-drug-allergy.js`, `test-ace-arb-postinit.js`, `test-warfarin-vka-eligibility.js`, `test-contraception-hrt-disambiguation.js`, `test-high-risk-unmatched.js`, `test-rule-coverage-view.js`, `test-rule-schema.js`, `test-rule-currency.js`, `test-monitoring-chip.js`, `test-chip-contract.js`, `test-checkin-prompts.js`, `test-brief-core.js`, `test-acb-scores.js`, `test-term-coverage.js`, `test-stopp-start.js`, `test-doac-core.js`, `test-clinical-thresholds-sync.js`, `test-repeat-authorisation.js`, `test-smr-pack-core.js`, `test-pipeline-e2e.js`, `test-preflight.js`, `test-matching-false-signals.js`, `test-txn-shadow.js`, `test-record-allergy-prompts.js`, `test-qof-indicator-filters.js` (CHA2DS2-VASc observation matching; keep with QOF).

CI (`.github/workflows/test.yml`) runs every `test-*.js` plus the defaults lock, doc-version ledger, and ESLint. `content-scripts/triage-lens/content.js` and the two `defaults.json` copies are byte-pinned. A chip-label or system-chip edit has to bump `defaults.json` `"version"`, regenerate the copies, and refresh the lock, or CI fails closed.

## What would break

Deleting `rules/drug-rules.json` or `engine/rules-engine.js`:

- Monitoring, Signing, Sweep, Companion "What's due", check-in prompts, and the queue `.ch-q-mon` chip throw or go blank on fetch.
- QOF and vaccine evaluation stop, because they are the same engine and the same Sentinel load (`content-scripts/sentinel.js` fetches both JSON files together).
- The four drug-allergy rules disappear.
- Options rules-currency and the Sentinel custom-rule editor still request the file.
- A practice-profile or suite backup import writes `sentinel.customRules` back, so a JSON delete does not stay deleted on a machine that restores.

Removing ACB:

- Record tab and structured medical record pack lose the score (`available: false` is already the window-less fallback, so the tab can render, but the score is gone).
- `engine/stopp-start.js` loses the anticholinergic drug list.
- `test-term-coverage.js` fails because `content.js` must call `window.ACBScores.computeACB`.

Removing Cockcroft-Gault:

- The Trends DOAC view loses CrCl and shows its existing "cannot calculate" path only if the function remains and returns a reason. Deleting `doac-core.js` breaks `trends.js` imports.

Removing the HRT dose table:

- Repeat-authorisation day-count for gel products loses its pack model. The pill still renders; the quantity judgement that H-076 covers gets worse.

Leaving the UI in place after emptying rules:

- Signing still says "no monitoring flags recorded", which is the designed empty state, and is easy to read as an all-clear despite the caveat (H-038).
- Coverage view reports every medicine unmatched, because `no-monitoring-common` is gone.
- StackChan goes idle when no QOF/vaccine chip is amber or red. That is a behaviour change, not a crash.

## Hazard-log entries that cover these controls

No hazard-log edit was made. The controls are still in the product. An UNSIGNED note belongs on the commit that actually removes them. The entries that describe the controls a later removal would drop:

| Entry | What it covers | If the control is removed |
|---|---|---|
| H-002 | False-negative on drug-monitoring and QOF chips. Absence of a chip is defined as "no data or no rule", not "clear" | Drug-monitoring absence becomes the product. The remaining mitigation is that wording, on every patient |
| H-003 | False-positive chips, including monitoring | Monitoring false positives stop. QOF false positives remain |
| H-004 | Practice-authored rule clinically wrong | Custom drug-monitoring rules are part of this. They also re-enter through backup |
| H-006 | Update regresses clinical logic. CI is the cited control | A lite branch that edits the engine is inside this hazard |
| H-007 | Automation bias toward displayed chips, including monitoring and scores | The displayed monitoring value is gone; over-trust of what remains (QOF, empty signing row) is the new shape |
| H-012 | Alert fatigue, hide/snooze of drug-monitoring and QOF chips | H-021 still applies to any QOF chips that remain |
| H-015 | eFI score inaccuracy | Retired with the Visualiser. No live calculator to remove |
| H-016 | Live PINCER, drug-monitoring, STOPP/START, and ACB false-negative | This is the hazard for stripping monitoring rules, the five library monitoring alerts, ACB, and STOPP together |
| H-017 | Visualiser PINCER false-positive | Retired. Live false positives are H-003 and H-019 |
| H-019 | STOPP/START prompts and the risk-tool signpost (QRISK3 / QCancer / eFI links). Pharmacy First is in the same entry and is not a calculator | Removing the signpost and STOPP/ACB drops those controls. Pharmacy First should stay |
| H-021 | Permanent hide of a drug-monitoring or QOF chip read as reassurance | Applies to whatever chips remain, and to a build where the chip is gone for everyone |
| H-025 | Trends misread from sparse points | The CrCl series is one of those charts |
| H-031 | Same patient, different score on two surfaces. ACB is called out from H-016 | Removing ACB removes the score; any leftover copy of the table would recreate the divergence the single scorer was built to stop |
| H-038 | Signing queue monitoring context read as "safe to sign" | The queue's only rank input is drug-monitoring. An empty rank is the hazard's scenario |
| H-054 | Ending a problem changes register and monitoring membership | The monitoring half of that downstream effect goes away; QOF register membership stays |
| H-076 | Repeat-authorisation pill quantity judgement | The HRT gram-dose table is an input to that judgement |

## What this branch does

The cut is on this branch only. `main` is unchanged. Nothing here is tagged, merged, or published.

- `rules/drug-rules.json` keeps the four `drug-allergy` rules. Every `drug-monitoring` and `drug-no-monitoring` rule is gone.
- `rules/alert-library.json` no longer has the five `drug-monitoring` library entries. Drug-combo, event-count, and composite entries stay.
- `evaluatePatient` skips `drug-monitoring` and `drug-no-monitoring`, including a custom rule of those types. QOF, vaccine, drug-combo, drug-allergy, event-count, and composite still run.
- Backup import drops those two types and reports them. A mixed backup still imports the other rules.
- `computeACB` returns `unavailable` and `total: null`. `ACB_TABLE` stays so STOPP can match drug names. A missing score is not shown as 0.
- `cockcroftGault` returns `reason: 'not-in-this-build'`. Recorded eGFR banding in QOF is unchanged.
- `rules/hrt-gram-dose-factors.json` has an empty product list, so gel days are not calculated.
- Queue `.ch-q-mon` is not fetched or re-injected. `.ch-q-result` and `.ch-queue-chips` stay.
- An UNSIGNED note in `docs/HAZARD-LOG.md` records the removed controls. It is not a sign-off.

## How to build the lite zip

Do not run `.github/workflows/release.yml`. That workflow publishes on a push to `main` and on a `v*` tag.

From this branch:

```
sh scripts/build-lite-zip.sh
```

`scripts/build-lite-zip.sh` packs a local zip of manifest 4.0.0. It does not tag or publish. Do not commit the zip.
