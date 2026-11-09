'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openBrowserLogin } = require('./browser-login');

test('manual login uses the collector profile with ordinary Chrome and releases ownership after exit', async () => {
  const child = new EventEmitter();
  let command, released = 0;
  const pending = openBrowserLogin({ site: 'axiom', chromePath: 'chrome', freeMemory: () => 3 * 1024 ** 3,
    lockProfile: () => ({ release: () => { released++; } }),
    spawnImpl: (file, args, options) => { command = { file, args, options }; return child; } });
  assert.equal(released, 0);
  assert(command.args[0].endsWith('axiom-research'));
  assert.equal(command.args.at(-1), 'https://axiom.trade');
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.stdio, 'ignore');
  assert(!command.args.some(arg => /remote-debugging|enable-automation|no-sandbox/.test(arg)));
  child.emit('exit', 0);
  assert.equal((await pending).automation_attached, false);
  assert.equal(released, 1);
});

test('invalid destination, missing Chrome and low memory fail before profile acquisition', async () => {
  let locks = 0;
  const options = { chromePath: 'chrome', freeMemory: () => 3 * 1024 ** 3,
    lockProfile: () => { locks++; throw Error('UNEXPECTED_LOCK'); } };
  await assert.rejects(openBrowserLogin({ ...options, site: 'https://example.com' }), /SITE_INVALID/);
  await assert.rejects(openBrowserLogin({ ...options, site: 'gmgn', chromePath: null }), /CHROME_MISSING/);
  await assert.rejects(openBrowserLogin({ ...options, site: 'gmgn', freeMemory: () => 0 }), /RAM_RESERVE/);
  assert.equal(locks, 0);
});

test('launch failures release the exact acquired profile lock', async () => {
  let released = 0;
  await assert.rejects(openBrowserLogin({ site: 'gmgn', chromePath: 'chrome', freeMemory: () => 3 * 1024 ** 3,
    lockProfile: directory => { assert(directory.endsWith('gmgn-login')); return { release: () => { released++; } }; },
    spawnImpl: () => { throw Error('SYNTHETIC_LAUNCH_FAILURE'); } }), /SYNTHETIC_LAUNCH_FAILURE/);
  assert.equal(released, 1);
});
