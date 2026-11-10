'use strict';

// Browser-only consumption of the owner's saved X state. Values never enter
// logs, tool results, prompts or publication artifacts.
const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_X_SESSION = path.resolve(__dirname, '../../x-session.json');

function xDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'x.com' || normalized.endsWith('.x.com') ||
    normalized === 'twitter.com' || normalized.endsWith('.twitter.com');
}

async function importResearchXSession(context, file = DEFAULT_X_SESSION) {
  if(file===null)return{imported:false,reason:'SAVED_X_SESSION_DISABLED'};
  if(typeof context?.cookies==='function'){
    const existing=await context.cookies('https://x.com');
    if(existing.some(cookie=>cookie.name==='auth_token'))return{imported:false,reason:'EXISTING_BROWSER_X_SESSION_PRESERVED'};
  }
  if (!fs.existsSync(file)) return { imported: false, reason: 'NO_SAVED_X_SESSION' };
  let state;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw Error();
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw Error();
  } catch { throw Error('RESEARCH_X_SESSION_INVALID'); }
  const cookies = state.cookies.filter(cookie => xDomain(cookie.domain));
  const origins = state.origins.filter(entry => {
    try { const url = new URL(entry.origin); return url.protocol === 'https:' && xDomain(url.hostname) && url.origin === entry.origin; }
    catch { return false; }
  });
  if (cookies.some(cookie => typeof cookie.name !== 'string' || typeof cookie.value !== 'string') ||
    origins.some(entry => !Array.isArray(entry.localStorage) || entry.localStorage.some(item =>
      typeof item.name !== 'string' || typeof item.value !== 'string'))) throw Error('RESEARCH_X_SESSION_INVALID');
  try {
    if (cookies.length) await context.addCookies(cookies);
    if (origins.length) await context.addInitScript(entries => {
      const entry = entries.find(item => item.origin === location.origin);
      if (entry) for (const item of entry.localStorage) localStorage.setItem(item.name, item.value);
    }, origins);
  } catch { throw Error('RESEARCH_X_SESSION_IMPORT_FAILED'); }
  return { imported: cookies.length > 0 || origins.length > 0 };
}

module.exports = { importResearchXSession };
