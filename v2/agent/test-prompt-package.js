'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildPrompt, loadStrategySeed, POLICY_FILES, STRATEGY_SEED_FILE, MAX_POLICY_BYTES } = require('./build-prompt');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'alphahands-v2-prompt-'));
  for (const name of POLICY_FILES) fs.writeFileSync(path.join(dir, name), `# ${name}\nFixture policy.\n`);
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('alphahands-v2-prompt-')) {
      throw new Error('Refusing cleanup outside the allocated prompt-test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: false });
  });
  return dir;
}

test('loads only the explicit policies, excluding unrelated/V1/environment files', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '.env'), 'SYNTHETIC_FIXTURE_ONLY=DO_NOT_LOAD\n');
  fs.writeFileSync(path.join(dir, 'system_prompt.txt'), 'UNRELATED_V1_SENTINEL');
  fs.writeFileSync(path.join(dir, 'README.md'), 'UNRELATED_README_SENTINEL');
  const bundle = buildPrompt(dir);
  assert.deepEqual(bundle.manifest.map((item) => item.file), [...POLICY_FILES]);
  assert.doesNotMatch(bundle.text, /SYNTHETIC_FIXTURE_ONLY|UNRELATED_V1_SENTINEL|UNRELATED_README_SENTINEL/);
});

test('assembly is deterministic and preserves each policy content with its hash', (t) => {
  const dir = fixture(t);
  const first = buildPrompt(dir);
  assert.deepEqual(first, buildPrompt(dir));
  for (const item of first.manifest) {
    const bytes = fs.readFileSync(path.join(dir, item.file));
    assert.ok(first.text.includes(bytes.toString('utf8')));
    assert.equal(item.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  fs.appendFileSync(path.join(dir, POLICY_FILES[0]), '\nChanged policy.\n');
  assert.notEqual(first.sha256, buildPrompt(dir).sha256);
});

test('missing required policy fails instead of falling back to V1', (t) => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, POLICY_FILES[1]));
  fs.writeFileSync(path.join(dir, 'system_prompt.txt'), 'FALLBACK_MUST_NOT_LOAD');
  assert.throws(() => buildPrompt(dir), { code: 'ENOENT' });
});

test('empty required policy fails visibly', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, POLICY_FILES[2]), ' \n\t');
  assert.throws(() => buildPrompt(dir), /policy is empty/);
});

test('invalid UTF-8 and BOM are rejected instead of silently altering instructions', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, POLICY_FILES[0]);
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  assert.throws(() => buildPrompt(dir), /not valid UTF-8/);
  fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0x41]));
  assert.throws(() => buildPrompt(dir), /without BOM/);
});

test('oversized policy fails instead of being truncated', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, POLICY_FILES[0]), Buffer.alloc(MAX_POLICY_BYTES + 1, 0x41));
  assert.throws(() => buildPrompt(dir), /exceeds byte limit/);
});

test('a directory cannot masquerade as a required instruction file', (t) => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, POLICY_FILES[0]));
  fs.mkdirSync(path.join(dir, POLICY_FILES[0]));
  assert.throws(() => buildPrompt(dir), /regular, non-symlink file/);
});

test('the real CLI check prints metadata only, with the worked example included', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'build-prompt.js'), '--check'], { encoding: 'utf8' }));
  assert.equal(result.version, '1.1.0');
  assert.deepEqual(result.manifest.map((item) => item.file), [...POLICY_FILES]);
  assert.equal(result.text, undefined);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.strategy_seed.file, STRATEGY_SEED_FILE);
  assert.equal(result.strategy_seed.text, undefined);
});

test('unsupported CLI arguments fail instead of starting an unintended workflow', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-prompt.js'), '--launch'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage:/);
});

test('strategy seed is separate data, never immutable prompt policy', (t) => {
  const dir = fixture(t);
  const seedPath = path.join(dir, STRATEGY_SEED_FILE);
  fs.writeFileSync(seedPath, '# Seed\nUNINITIALIZED_STRATEGY_SENTINEL\n');
  const seed = loadStrategySeed(dir);
  assert.match(seed.text, /UNINITIALIZED_STRATEGY_SENTINEL/);
  assert.doesNotMatch(buildPrompt(dir).text, /UNINITIALIZED_STRATEGY_SENTINEL/);
  assert.equal(seed.sha256, crypto.createHash('sha256').update(fs.readFileSync(seedPath)).digest('hex'));
  assert.equal(fs.readFileSync(seedPath, 'utf8'), seed.text);
});

test('seed initialization fails if missing or empty, while instruction-only assembly remains available', (t) => {
  const dir = fixture(t);
  assert.throws(() => loadStrategySeed(dir), { code: 'ENOENT' });
  assert.ok(buildPrompt(dir).text);
  fs.writeFileSync(path.join(dir, STRATEGY_SEED_FILE), '\n\t');
  assert.throws(() => loadStrategySeed(dir), /seed is empty/);
});

test('actual assembled policy includes selective phases and current model roles without imposing a fixed strategy form', () => {
  const bundle = buildPrompt();
  assert.ok(bundle.manifest.some(item => item.file === 'MARKET_RESEARCH_GUIDE.md'));
  assert.match(bundle.text, /Rotation.*Euphoria.*Fatigue.*Cooked/s);
  assert.match(bundle.text, /If there is no visible supported edge.*do not trade/s);
  assert.match(bundle.text, /sector phase, exact-token lifecycle and audience discovery/);
  assert.match(bundle.text, /GPT-6\.1 Sol at medium/);
  assert.doesNotMatch(bundle.text, /intended roles are GPT-6\.1 Terra/);
  assert.match(bundle.text, /no compulsory strategy field names/);
  assert.match(bundle.text, /Search snippets remain snippets/);
});
