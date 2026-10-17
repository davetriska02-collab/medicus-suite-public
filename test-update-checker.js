// Medicus Suite v1.3.1 — Update Checker Tests
// Run with: node test-update-checker.js

'use strict';

// Mock chrome before loading the module
const mockStore = {};
global.chrome = {
  storage: {
    local: {
      get: async (keysOrKey) => {
        if (typeof keysOrKey === 'string') return { [keysOrKey]: mockStore[keysOrKey] };
        if (Array.isArray(keysOrKey)) {
          const out = {};
          for (const k of keysOrKey) if (mockStore[k] !== undefined) out[k] = mockStore[k];
          return out;
        }
        return { ...mockStore };
      },
      set: async (obj) => {
        Object.assign(mockStore, obj);
      },
    },
  },
  runtime: { getManifest: () => ({ version: '1.3.1' }) },
};

const UC = require('./shared/update-checker.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  OK  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

// ── Version normalisation ────────────────────────────────────────────────────

console.log('\n--- normaliseVersion ---');
assert(UC.normaliseVersion('v1.2.3') === '1.2.3', 'strips leading v');
assert(UC.normaliseVersion('V1.2.3') === '1.2.3', 'strips leading V (case-insensitive)');
assert(UC.normaliseVersion('1.2.3') === '1.2.3', 'passes through if no v');
assert(UC.normaliseVersion('  v1.2.3  ') === '1.2.3', 'trims whitespace');
assert(UC.normaliseVersion(null) === '', 'null → empty');
assert(UC.normaliseVersion(undefined) === '', 'undefined → empty');

// ── Comparison ───────────────────────────────────────────────────────────────

console.log('\n--- compareVersions ---');
assert(UC.compareVersions('1.0.0', '1.0.0') === 0, 'equal versions');
assert(UC.compareVersions('1.0.1', '1.0.0') === 1, 'patch greater');
assert(UC.compareVersions('1.1.0', '1.0.9') === 1, 'minor greater');
assert(UC.compareVersions('2.0.0', '1.99.99') === 1, 'major greater');
assert(UC.compareVersions('1.0.0', '1.0.1') === -1, 'patch less');
assert(UC.compareVersions('v1.3.0', '1.3.0') === 0, 'leading v ignored');
assert(UC.compareVersions('1.3', '1.3.0') === 0, 'missing patch treated as 0');
assert(UC.compareVersions('1.3.0', '1.3') === 0, 'extra zero patch equal');

console.log('\n--- isNewer ---');
assert(UC.isNewer('1.3.1', '1.3.0') === true, 'newer patch');
assert(UC.isNewer('v1.3.1', '1.3.0') === true, 'newer with v prefix');
assert(UC.isNewer('1.3.0', '1.3.0') === false, 'same version not newer');
assert(UC.isNewer('1.2.9', '1.3.0') === false, 'older not newer');
assert(UC.isNewer('', '1.3.0') === false, 'empty latest never newer');

// ── checkForUpdate ────────────────────────────────────────────────────────────

(async () => {
  console.log('\n--- checkForUpdate (mocked fetch) ---');

  // Clear store
  for (const k of Object.keys(mockStore)) delete mockStore[k];

  const mockReleaseResponse = {
    tag_name: 'v1.4.0',
    html_url: 'https://github.com/davetriska02-collab/medicus-suite/releases/tag/v1.4.0',
    body: "## What's new\nFeature X, fix Y",
    assets: [
      { name: 'medicus-suite-v1.4.0.zip', browser_download_url: 'https://github.com/.../medicus-suite-v1.4.0.zip' },
    ],
    zipball_url: 'https://api.github.com/.../zipball/v1.4.0',
  };

  const mockFetch = async (url) => ({
    ok: true,
    json: async () => mockReleaseResponse,
  });

  const r1 = await UC.checkForUpdate({ fetchImpl: mockFetch });
  assert(r1.ok === true, 'checkForUpdate: ok on success');
  assert(r1.latestVersion === '1.4.0', 'checkForUpdate: latest version extracted and v stripped');
  assert(r1.downloadUrl.endsWith('.zip'), 'checkForUpdate: prefers zip asset over zipball');
  assert(r1.releaseUrl.includes('releases/tag/v1.4.0'), 'checkForUpdate: release URL captured');

  // Second call within cooldown should be skipped
  let fetchCallCount = 0;
  const countingFetch = async () => {
    fetchCallCount++;
    return { ok: true, json: async () => mockReleaseResponse };
  };
  const r2 = await UC.checkForUpdate({ fetchImpl: countingFetch });
  assert(r2.ok === true && r2.skipped === true, 'checkForUpdate: respects cooldown');
  assert(fetchCallCount === 0, 'checkForUpdate: no fetch on cooldown skip');

  // Force flag bypasses cooldown
  const r3 = await UC.checkForUpdate({ force: true, fetchImpl: countingFetch });
  assert(r3.ok === true && !r3.skipped, 'checkForUpdate: force bypasses cooldown');
  assert(fetchCallCount === 1, 'checkForUpdate: force triggers actual fetch');

  // Error handling — HTTP 500 still stores a banner string
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  const mockFetch500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const rErr = await UC.checkForUpdate({ fetchImpl: mockFetch500 });
  assert(rErr.ok === false, 'checkForUpdate: ok=false on HTTP error');
  assert(rErr.error.includes('500'), 'checkForUpdate: error includes status code');
  assert(rErr.quiet !== true, 'checkForUpdate: a 500 is not a quiet miss');
  assert(mockStore['suite.update.error'].includes('500'), 'checkForUpdate: 500 is stored for the Options line');

  // Missing public repo (404) and a network failure stay quiet: no stored error.
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  mockStore['suite.update.error'] = 'GitHub API HTTP 500';
  const mockFetch404 = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const rMissing = await UC.checkForUpdate({ force: true, fetchImpl: mockFetch404 });
  assert(rMissing.ok === false && rMissing.quiet === true, 'checkForUpdate: 404 is a quiet miss');
  assert(rMissing.unreachable === true, 'checkForUpdate: 404 is unreachable');
  assert(rMissing.error == null, 'checkForUpdate: 404 does not return an error string');
  assert(mockStore['suite.update.error'] == null, 'checkForUpdate: 404 clears a stored error');
  assert(mockStore['suite.update.checkedAt'] > 0, 'checkForUpdate: 404 still records a check time');

  const mockFetchThrows = async () => {
    throw new Error('DNS lookup failed');
  };
  mockStore['suite.update.error'] = 'GitHub API HTTP 500';
  const rNet = await UC.checkForUpdate({ force: true, fetchImpl: mockFetchThrows });
  assert(rNet.ok === false && rNet.quiet === true, 'checkForUpdate: network failure is quiet');
  assert(rNet.error == null, 'checkForUpdate: network failure does not return an error string');
  assert(mockStore['suite.update.error'] == null, 'checkForUpdate: network failure clears a stored error');

  // No zip asset — falls back to zipball_url (must be a github.com URL to pass host validation)
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  const responseNoAssets = {
    ...mockReleaseResponse,
    assets: [],
    zipball_url: 'https://api.github.com/repos/davetriska02-collab/medicus-suite/zipball/v1.4.0',
  };
  const rFallback = await UC.checkForUpdate({
    fetchImpl: async () => ({ ok: true, json: async () => responseNoAssets }),
  });
  assert(
    rFallback.downloadUrl.includes('api.github.com'),
    'checkForUpdate: falls back to zipball_url when no zip asset (github host passes)'
  );

  // ── isUpdateAvailable ─────────────────────────────────────────────────────
  console.log('\n--- isUpdateAvailable ---');
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  await UC.checkForUpdate({ force: true, fetchImpl: mockFetch });
  // Mock manifest version is 1.3.1, latest is 1.4.0 → update available
  const avail = await UC.isUpdateAvailable();
  assert(avail === true, 'isUpdateAvailable: true when GitHub has newer version');

  // Now set latestVersion to match installed
  global.chrome.runtime.getManifest = () => ({ version: '1.4.0' });
  const noAvail = await UC.isUpdateAvailable();
  assert(noAvail === false, 'isUpdateAvailable: false when GitHub matches installed');

  // And when GitHub is older (shouldn't happen but defensive)
  global.chrome.runtime.getManifest = () => ({ version: '1.5.0' });
  const stale = await UC.isUpdateAvailable();
  assert(stale === false, 'isUpdateAvailable: false when installed is ahead of GitHub');

  // ── getState ──────────────────────────────────────────────────────────────
  console.log('\n--- getState ---');
  const state = await UC.getState();
  assert(state.latestVersion === '1.4.0', 'getState: returns stored latestVersion');
  assert(state.releaseUrl?.includes('github.com'), 'getState: returns stored releaseUrl');
  assert(state.checkedAt > 0, 'getState: checkedAt is a timestamp');

  // ── allowGithubUrl: host validation ──────────────────────────────────────
  console.log('\n--- allowGithubUrl: host validation ---');
  // Evil URL must be blocked
  assert(UC.allowGithubUrl('https://evil.example/x.zip') === '', 'allowGithubUrl: evil host → empty string');
  // github.com passes
  assert(
    UC.allowGithubUrl('https://github.com/davetriska02-collab/medicus-suite/releases/tag/v1.4.0').includes(
      'github.com'
    ),
    'allowGithubUrl: github.com host passes through'
  );
  // api.github.com passes
  assert(
    UC.allowGithubUrl('https://api.github.com/repos/foo/bar/zipball/v1.0.0').includes('api.github.com'),
    'allowGithubUrl: api.github.com host passes through'
  );
  // githubusercontent.com subdomain passes
  assert(
    UC.allowGithubUrl('https://objects.githubusercontent.com/foo.zip').includes('githubusercontent.com'),
    'allowGithubUrl: *.githubusercontent.com passes through'
  );
  // HTTP (not HTTPS) must be blocked
  assert(UC.allowGithubUrl('http://github.com/foo.zip') === '', 'allowGithubUrl: http:// (not https) → empty string');
  // Empty and null inputs
  assert(UC.allowGithubUrl('') === '', 'allowGithubUrl: empty string → empty string');
  assert(UC.allowGithubUrl(null) === '', 'allowGithubUrl: null → empty string');

  // ── checkForUpdate: evil asset URL → downloadUrl is blocked ──────────────
  console.log('\n--- checkForUpdate: evil downloadUrl blocked ---');
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  const evilAssetResponse = {
    tag_name: 'v1.5.0',
    html_url: 'https://github.com/davetriska02-collab/medicus-suite/releases/tag/v1.5.0',
    body: 'notes',
    assets: [{ name: 'medicus-suite.zip', browser_download_url: 'https://evil.example/x.zip' }],
    zipball_url: 'https://api.github.com/repos/foo/bar/zipball/v1.5.0',
  };
  const rEvil = await UC.checkForUpdate({
    force: true,
    fetchImpl: async () => ({ ok: true, json: async () => evilAssetResponse }),
  });
  assert(rEvil.downloadUrl === '', 'checkForUpdate: evil asset URL → downloadUrl is empty string');

  // ── Hardcoded URL sanity ──────────────────────────────────────────────────
  console.log('\n--- Hardcoded constants ---');
  assert(UC.REPO_OWNER === 'davetriska02-collab', "REPO_OWNER points to Dave's repo");
  assert(UC.REPO_NAME === 'medicus-suite-public', 'REPO_NAME is the public releases repo');
  assert(
    UC.RELEASES_URL === 'https://api.github.com/repos/davetriska02-collab/medicus-suite-public/releases/latest',
    'RELEASES_URL is the public releases endpoint'
  );

  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));
  assert(
    manifest.host_permissions.includes('https://api.github.com/repos/davetriska02-collab/medicus-suite-public/*'),
    'manifest host permission is the public releases repo'
  );
  assert(
    !manifest.host_permissions.some((p) => p.includes('/medicus-suite/*')),
    'manifest does not permission the private repo releases API'
  );

  const optionsHtml = fs.readFileSync('./options/options.html', 'utf8');
  assert(
    optionsHtml.includes('https://github.com/davetriska02-collab/medicus-suite-public/blob/main/docs/HAZARD-LOG.md'),
    'Options hazard-log link is the public repo'
  );
  assert(
    !optionsHtml.includes('github.com/davetriska02-collab/medicus-suite/'),
    'Options does not link the private repo'
  );

  const optionsJs = fs.readFileSync('./options/options.js', 'utf8');
  assert(optionsJs.includes('if (!res.ok && !res.quiet)'), 'Options skips the failure line when the check is quiet');

  const readme = fs.readFileSync('./README.md', 'utf8');
  assert(
    readme.includes('https://github.com/davetriska02-collab/medicus-suite-public/releases/latest'),
    'README download link is the public releases page'
  );

  const releaseYml = fs.readFileSync('./.github/workflows/release.yml', 'utf8');
  assert(releaseYml.includes('${{ github.repository }}'), 'release workflow uses the repository it runs in');
  assert(
    !releaseYml.includes('davetriska02-collab/medicus-suite'),
    'release workflow does not hardcode a repository slug'
  );

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  if (failed > 0) process.exit(1);
})();
