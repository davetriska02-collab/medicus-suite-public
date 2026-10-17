// Medicus Suite — every backup module restores its OWN export, including one taken on a machine where nothing was ever set (2026-10-07).
// Run with: node test-io-empty-roundtrip.js
//
// Found live (a work PC restoring onto another machine): "Restore failed: requestMonitor.enabled must be a boolean (got null). — no changes were applied".
// requestMonitorExport writes `null` for every setting the machine never had, and requestMonitorImport rejected a null boolean, so a backup
// from a machine that had never opened the Request Monitor could not be restored at all (and the restore is all-or-nothing). The rule this
// test pins, for EVERY shared/io/*-io.js export/import pair: an export taken from EMPTY storage must import without throwing.

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

function makeStorage(initial) {
  const store = { ...(initial || {}) };
  const pick = (keys) => {
    const out = {};
    if (keys == null) return JSON.parse(JSON.stringify(store));
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
    list.forEach((k) => {
      if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
      else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
    });
    return out;
  };
  return {
    store,
    area: {
      get: async (k) => pick(k),
      set: async (o) => Object.keys(o).forEach((k) => (store[k] = JSON.parse(JSON.stringify(o[k])))),
      remove: async (k) => (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]),
    },
  };
}

function loadAll(storage) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    // the shipped catalogue is read with fetch(chrome.runtime.getURL(...)) — serve it from disk
    fetch: async (u) => {
      const f = path.join(__dirname, String(u).replace(/^\//, ''));
      if (!fs.existsSync(f)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) };
    },
    TextEncoder,
    TextDecoder,
    crypto: require('crypto').webcrypto,
    chrome: {
      storage: { local: storage.area, session: storage.area, sync: storage.area, onChanged: { addListener() {} } },
      runtime: { getURL: (p) => '/' + p, sendMessage: async () => {}, onMessage: { addListener() {} } },
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const skipped = [];
  // The scripts the Options page itself loads, in ITS order (the restore runs there, with the cores each module validates against),
  // tolerating one that cannot run outside a browser.
  const html = fs.readFileSync(path.join(__dirname, 'options', 'options.html'), 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+\.js)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  for (const rel of srcs) {
    const f = path.join(__dirname, 'options', rel);
    if (!fs.existsSync(f)) continue;
    try {
      vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      skipped.push(rel + ': ' + String(e && e.message).slice(0, 70));
    }
  }
  return { ctx, skipped };
}

(async () => {
  const { ctx, skipped } = loadAll(makeStorage());
  const names = Object.keys(ctx).filter((k) => typeof ctx[k] === 'function');
  const pairs = names
    .filter((n) => /Export$/.test(n) && names.includes(n.replace(/Export$/, 'Import')))
    .map((n) => [n, n.replace(/Export$/, 'Import')]);
  check(pairs.length >= 15, 'the IO modules were found (' + pairs.length + ' export/import pairs)');
  if (skipped.length) console.log('  (not loadable on their own, skipped: ' + skipped.join('; ') + ')');

  for (const [exp, imp] of pairs) {
    // a fresh, EMPTY machine each time
    const empty = loadAll(makeStorage());
    let step = 'export';
    try {
      const data = await empty.ctx[exp]();
      step = 'import';
      const copy = JSON.parse(JSON.stringify(data === undefined ? null : data));
      await empty.ctx[imp](copy);
      check(true, exp + ' → ' + imp + ': an export from empty storage restores cleanly');
    } catch (e) {
      check(
        false,
        exp +
          ' → ' +
          imp +
          ': an export from empty storage must restore cleanly — failed on ' +
          step +
          ': ' +
          (e && e.message)
      );
    }
  }

  // The reported case, exactly: a backup that carries nulls for settings the source machine never had.
  {
    const target = makeStorage({
      'suite.requestMonitor.enabled': true,
      'suite.requestMonitor.pollSeconds': 120,
      'suite.requestMonitor.assigneeId': 'abc',
      'suite.requestMonitor.notifyEnabled': true,
      'suite.requestMonitor.notifySound': false,
      'suite.requestMonitor.urgentAgeAmberHours': 2,
      'suite.requestMonitor.urgentAgeRedHours': 4,
    });
    const { ctx: c } = loadAll(target);
    const backup = {
      enabled: null,
      assigneeId: null,
      pollSeconds: null,
      notifyEnabled: null,
      notifySound: null,
      urgentAgeAmberHours: null,
      urgentAgeRedHours: null,
    };
    let threw = null;
    try {
      await c.requestMonitorImport(backup);
    } catch (e) {
      threw = e;
    }
    check(
      !threw,
      'a backup full of nulls (settings the source never had) restores without error' +
        (threw ? ': ' + threw.message : '')
    );
    check(
      target.store['suite.requestMonitor.enabled'] === true &&
        target.store['suite.requestMonitor.pollSeconds'] === 120 &&
        target.store['suite.requestMonitor.assigneeId'] === 'abc' &&
        target.store['suite.requestMonitor.notifyEnabled'] === true &&
        target.store['suite.requestMonitor.notifySound'] === false &&
        target.store['suite.requestMonitor.urgentAgeAmberHours'] === 2 &&
        target.store['suite.requestMonitor.urgentAgeRedHours'] === 4,
      'and a null does NOT overwrite a setting the target machine already has'
    );
    let bad = null;
    try {
      await c.requestMonitorImport({ enabled: 'yes' });
    } catch (e) {
      bad = e;
    }
    check(
      !!bad && /must be a boolean/.test(bad.message),
      'a genuinely wrong value (a string where a boolean belongs) is still rejected'
    );
    await c.requestMonitorImport({ enabled: false, notifySound: true });
    check(
      target.store['suite.requestMonitor.enabled'] === false &&
        target.store['suite.requestMonitor.notifySound'] === true,
      'real values still restore'
    );
    await c.requestMonitorImport({ assigneeId: '' });
    check(
      target.store['suite.requestMonitor.assigneeId'] === '',
      'an assignee saved as an empty string (cleared on the source) still restores'
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
