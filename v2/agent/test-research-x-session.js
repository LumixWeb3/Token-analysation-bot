'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importResearchXSession } = require('./research-x-session');

function fixture(t, data) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alphahands-x-import-'));
  const file = path.join(root, 'fixture-state.json');
  fs.writeFileSync(file, JSON.stringify(data));
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(root); });
  return file;
}

test('browser consumes only X state while other site sign-ins stay outside the import', async t => {
  const file = fixture(t, { cookies: [
    { name: 'fixture', value: 'synthetic-x-cookie', domain: '.x.com', path: '/' },
    { name: 'fixture', value: 'synthetic-other-cookie', domain: '.google.com', path: '/' }
  ], origins: [
    { origin: 'https://x.com', localStorage: [{ name: 'fixture', value: 'synthetic-storage' }] },
    { origin: 'https://mail.example.com', localStorage: [{ name: 'omit', value: 'synthetic-omit' }] }
  ] });
  let cookies, origins;
  const result = await importResearchXSession({ addCookies: async value => { cookies = value; },
    addInitScript: async (_, value) => { origins = value; } }, file);
  assert.deepEqual(result, { imported: true });
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].domain, '.x.com');
  assert.equal(origins.length, 1);
  assert.equal(origins[0].origin, 'https://x.com');
  assert(!JSON.stringify(result).includes('synthetic'));
});

test('missing or disabled saved state leaves manual browser login available', async () => {
  const context = { addCookies: () => { throw Error('MUST_NOT_IMPORT'); } };
  assert.equal((await importResearchXSession(context, null)).imported, false);
});

test('fresh manual X sign-in is preserved before opening any older saved state', async () => {
  let imports = 0;
  const result = await importResearchXSession({
    cookies: async () => [{ name: 'auth_token', value: 'synthetic-current-session' }],
    addCookies: async () => { imports++; }
  }, 'this-file-must-never-be-opened.json');
  assert.equal(result.reason, 'EXISTING_BROWSER_X_SESSION_PRESERVED');
  assert.equal(imports, 0);
});

test('malformed state and browser errors are reported without copying error details', async t => {
  const malformed = fixture(t, { cookies: [], origins: null });
  await assert.rejects(importResearchXSession({}, malformed), /^Error: RESEARCH_X_SESSION_INVALID$/);
  const valid = fixture(t, { cookies: [{ name: 'fixture', value: 'synthetic-cookie', domain: 'x.com' }], origins: [] });
  await assert.rejects(importResearchXSession({ addCookies: async () => { throw Error('SYNTHETIC_PRIVATE_BROWSER_DETAILS'); } }, valid),
    /^Error: RESEARCH_X_SESSION_IMPORT_FAILED$/);
});
