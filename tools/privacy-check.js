'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const findings = [];
const rules = [
  ['SECRET_TOKEN', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,}|xox[baprs]-[A-Za-z0-9-]{15,})/g],
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['DISCORD_WEBHOOK', /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g],
  ['DISCORD_TOKEN', /["'`](?:[A-Za-z0-9_-]{23,28})\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}["'`]/g],
  ['PERSONAL_PATH', /(?:[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[A-Za-z0-9_. -]+[\\/]|\/home\/(?!runner\b|node\b|user\b)[A-Za-z0-9_.-]+\/)/gi],
  ['HARDCODED_CREDENTIAL', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|webhook[_-]?url)\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/gi],
  ['POSSIBLE_DISCORD_ID', /["']\d{17,20}["']/g],
  ['EMAIL_ADDRESS', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g]
];
const ignored = new Set(['.git', 'node_modules']);
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { findings.push({ file: relative, rule: 'SYMLINK' }); continue; }
    if (entry.isDirectory()) { scan(full); continue; }
    if ((/(?:^|\/)(?:runtime-browser-profiles|v2-runtime|scan-history|scan-traces|cloud-auth|session|run-records|outcome-records|private)(?:\/|$)/.test(relative)) ||
        /(?:^|\/)(?:\.env(?:\..*)?|accounts?\.(?:db|json)|auth\.json|.*\.(?:key|enc|db|sqlite|har|zip|png))$/i.test(relative) && !relative.endsWith('.env.example')) {
      findings.push({ file: relative, rule: 'PRIVATE_ARTIFACT_PATH' });
    }
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) { findings.push({ file: relative, rule: 'UNREVIEWED_BINARY' }); continue; }
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      for (const [rule, pattern] of rules) {
        pattern.lastIndex = 0;
        const matches = [...lines[index].matchAll(pattern)];
        if (!matches.length) continue;
        if (rule === 'HARDCODED_CREDENTIAL' && matches.every(match => /fixture|synthetic|example|fake|test|must.not|do.not|should.not|redact|your[_ -]|placeholder|process\.env/i.test(match[1]))) continue;
        if (rule === 'EMAIL_ADDRESS' && relative.endsWith('package-lock.json')) continue;
        if (rule === 'EMAIL_ADDRESS' && matches.every(match => /@(?:example\.(?:com|org|net)|localhost\.test)$/i.test(match[0]))) continue;
        if (rule === 'POSSIBLE_DISCORD_ID' && matches.every(match => /^["']100000000000000\d{3}["']$/.test(match[0]))) continue;
        if (rule === 'POSSIBLE_DISCORD_ID' && /(?:test-|fixture)/i.test(relative) && matches.every(match => /^(?:["'](?:1234567890)+\d*["']|["']1+["']|["']0+["'])$/.test(match[0]))) continue;
        findings.push({ file: relative, line: index + 1, rule });
      }
    }
  }
}
scan(root);
process.stdout.write(JSON.stringify({ scanned_root: path.basename(root), findings }, null, 2) + '\n');
process.exitCode = findings.length ? 1 : 0;
