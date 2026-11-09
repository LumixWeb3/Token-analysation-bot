'use strict';

const os = require('node:os');
const { spawn } = require('node:child_process');
const { findChromePath } = require('../../installed-chrome-path');
const { profileDirectory, acquireProfileLock } = require('../../gmgn-browser-profile');

const SITES = Object.freeze({
  gmgn: { profileName: 'gmgn-login', url: 'https://gmgn.ai' },
  axiom: { profileName: 'axiom-research', url: 'https://axiom.trade' }
});

async function openBrowserLogin({ site, spawnImpl = spawn, chromePath = findChromePath(),
  freeMemory = os.freemem, lockProfile = acquireProfileLock, profileRoot } = {}) {
  if (!Object.hasOwn(SITES, site)) throw Error('BROWSER_LOGIN_SITE_INVALID');
  if (!chromePath) throw Error('BROWSER_LOGIN_CHROME_MISSING');
  if (freeMemory() < 2.25 * 1024 ** 3) throw Error('BROWSER_LOGIN_RAM_RESERVE');
  const settings = SITES[site];
  const directory = profileDirectory({ role: 'v2-browser-login', chain: 'solana',
    profileName: settings.profileName, ...(profileRoot ? { rootDir: profileRoot } : {}) });
  const lock = lockProfile(directory);
  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(chromePath, [
        '--user-data-dir=' + directory, '--no-first-run', '--disable-background-mode', settings.url
      ], { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => reject(Error('BROWSER_LOGIN_LAUNCH_FAILED')));
      child.once('exit', code => code === 0 ? resolve() : reject(Error('BROWSER_LOGIN_CHROME_EXITED')));
    });
    return { site, profile: settings.profileName, window_closed: true, automation_attached: false };
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--site=')) {
    process.stderr.write('Usage: node v2/agent/browser-login.js --site=gmgn | --site=axiom\n');
    process.exitCode = 1;
  } else {
    openBrowserLogin({ site: args[0].slice(7) }).then(
      result => process.stdout.write(JSON.stringify(result) + '\n'),
      error => { process.stderr.write(/^BROWSER_LOGIN_[A-Z_]+$/.test(error.message) ? error.message + '\n' : 'BROWSER_LOGIN_UNAVAILABLE\n'); process.exitCode = 1; }
    );
  }
}

module.exports = { openBrowserLogin };
