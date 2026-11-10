'use strict';

const os = require('node:os');
const { launchManagedPersistentContext } = require('../../gmgn-browser-profile');
const { importResearchXSession } = require('./research-x-session');

// A session owns one lazy browser and one page. Tool leases release the page
// for subsequent calls while session.close releases Chrome and the profile.
function createResearchBrowser({ headless = true, profileRoot, freeMemory = os.freemem,
  launchManaged = launchManagedPersistentContext, chromium, xSessionFile } = {}) {
  if (typeof headless !== 'boolean') throw Error('RESEARCH_BROWSER_MODE_INVALID');
  let managed, launching, busy = false, closed = false, faulted = false, sessionInitialized = false;

  async function acquirePage({ service } = {}) {
    if (!['web', 'x', 'gmgn'].includes(service)) throw Error('RESEARCH_BROWSER_SERVICE_INVALID');
    if (closed || faulted) throw Error('RESEARCH_BROWSER_UNAVAILABLE');
    if (busy) throw Error('RESEARCH_BROWSER_BUSY');
    const minimum = managed ? 1.5 : 2.25;
    const availableMemory = freeMemory();
    if (!Number.isFinite(availableMemory) || availableMemory < minimum * 1024 ** 3) {
      faulted = true;
      throw Error('RESEARCH_BROWSER_RAM_RESERVE');
    }
    busy = true;
    try {
      if (!launching) {
        launching = Promise.resolve().then(() => launchManaged({
          chromium: chromium || require('playwright').chromium,
          role: 'v2-web-research', chain: 'solana', profileName: 'axiom-research',
          headless, serviceWorkers: 'block', ...(profileRoot ? { rootDir: profileRoot } : {})
        }));
      }
      managed = await launching;
      if (closed) throw Error('RESEARCH_BROWSER_CLOSED_DURING_LAUNCH');
      if (!managed?.page || typeof managed.close !== 'function') throw Error('RESEARCH_BROWSER_LAUNCH_INVALID');
      if (!sessionInitialized) {
        await importResearchXSession(managed.context, xSessionFile);
        sessionInitialized = true;
      }
      let released = false;
      return { owned: true, page: managed.page, release: async () => {
        if (released) return;
        released = true;
        busy = false;
      } };
    } catch (error) {
      busy = false;
      faulted = true;
      throw error;
    }
  }

  let closing;
  function close() {
    closed = true;
    if (!closing) closing = (async () => {
      let resource = managed;
      if (!resource && launching) {
        try { resource = await launching; } catch { return; }
      }
      if (resource) await resource.close();
    })();
    return closing;
  }

  return { acquirePage, close };
}

module.exports = { createResearchBrowser };
