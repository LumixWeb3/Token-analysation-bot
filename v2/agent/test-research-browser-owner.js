'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchBrowser } = require('./research-browser-owner');

test('one lazy browser owns the same page across exclusive tool leases', async () => {
  let launches = 0, closes = 0, options;
  const page = {};
  const owner = createResearchBrowser({ xSessionFile: null, chromium: {}, freeMemory: () => 3 * 1024 ** 3,
    launchManaged: async input => { options = input; launches++; return { page, close: async () => { closes++; } }; } });
  assert.equal(launches, 0);
  const first = await owner.acquirePage({ service: 'web' });
  await assert.rejects(owner.acquirePage({ service: 'x' }), /BUSY/);
  assert.equal(options.serviceWorkers, 'block');
  assert.equal(options.profileName, 'axiom-research');
  await first.release();
  await first.release();
  const next = await owner.acquirePage({ service: 'x' });
  assert.equal(next.page, first.page);
  assert.equal(launches, 1);
  await next.release();
  await owner.close();
  await owner.close();
  assert.equal(closes, 1);
  await assert.rejects(owner.acquirePage({ service: 'web' }), /UNAVAILABLE/);
});

test('closing during browser launch closes the late browser and never hands it to a tool', async () => {
  let complete, closes = 0;
  const owner = createResearchBrowser({ xSessionFile: null, chromium: {}, freeMemory: () => 3 * 1024 ** 3,
    launchManaged: () => new Promise(resolve => { complete = resolve; }) });
  const acquiring = owner.acquirePage({ service: 'web' });
  await new Promise(resolve => setImmediate(resolve));
  const closing = owner.close();
  complete({ page: {}, close: async () => { closes++; } });
  await assert.rejects(acquiring, /CLOSED_DURING_LAUNCH/);
  await closing;
  assert.equal(closes, 1);
});

test('low memory and a failed launch fail closed without repeated browser launches', async () => {
  let launches = 0;
  const launchManaged = async () => { launches++; throw Error('SYNTHETIC_LAUNCH_FAILURE'); };
  const low = createResearchBrowser({ xSessionFile: null, chromium: {}, freeMemory: () => 0, launchManaged });
  await assert.rejects(low.acquirePage({ service: 'web' }), /RAM_RESERVE/);
  await low.close();
  assert.equal(launches, 0);
  const failed = createResearchBrowser({ xSessionFile: null, chromium: {}, freeMemory: () => 3 * 1024 ** 3, launchManaged });
  await assert.rejects(failed.acquirePage({ service: 'web' }), /SYNTHETIC_LAUNCH_FAILURE/);
  await assert.rejects(failed.acquirePage({ service: 'web' }), /UNAVAILABLE/);
  await failed.close();
  assert.equal(launches, 1);
});

test('closing an unused owner never starts Chrome', async () => {
  const owner = createResearchBrowser({ launchManaged: () => { throw Error('MUST_NOT_LAUNCH'); } });
  await owner.close();
  await assert.rejects(owner.acquirePage({ service: 'web' }), /UNAVAILABLE/);
});
