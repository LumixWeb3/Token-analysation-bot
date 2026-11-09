'use strict';

// Offline, explicit assembly only. This module never starts Codex or bot services.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const POLICY_FILES = Object.freeze([
  'SYSTEM_PROMPT.md',
  'OPERATING_INSTRUCTIONS.md',
  'MARKET_RESEARCH_GUIDE.md',
  'STRATEGY_EXAMPLE.md'
]);
const MAX_POLICY_BYTES = 128 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024;
const STRATEGY_SEED_FILE = 'STRATEGY.md';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildPrompt(rootDir = __dirname) {
  const root = fs.realpathSync(rootDir);
  const manifest = [];
  const sections = [];
  for (const name of POLICY_FILES) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Required policy must be a regular, non-symlink file: ${name}`);
    }
    if (stat.size > MAX_POLICY_BYTES) {
      throw new Error(`Required policy exceeds byte limit: ${name}`);
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_POLICY_BYTES) {
      throw new Error(`Required policy exceeds byte limit: ${name}`);
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new Error(`Required policy must use UTF-8 without BOM: ${name}`);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Required policy is not valid UTF-8: ${name}`);
    }
    if (!text.trim()) throw new Error(`Required policy is empty: ${name}`);
    manifest.push({
      file: name,
      bytes: bytes.length,
      words: text.trim().split(/\s+/u).length,
      sha256: sha256(bytes)
    });
    sections.push(`<!-- Begin ${name} -->\n${text}\n<!-- End ${name} -->`);
  }
  const text = '# AlphaHands V2 instruction bundle\n\n' + sections.join('\n\n---\n\n') + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BUNDLE_BYTES) throw new Error('Instruction bundle exceeds byte limit');
  return {
    version: '1.1.0',
    text,
    bytes,
    words: manifest.reduce((total, item) => total + item.words, 0),
    sha256: sha256(text),
    manifest
  };
}

// Explicit initialization input, deliberately excluded from immutable instructions.
// Returning this seed never copies it over a persisted/accepted live strategy.
function loadStrategySeed(rootDir = __dirname) {
  const root = fs.realpathSync(rootDir);
  const file = path.join(root, STRATEGY_SEED_FILE);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Strategy seed must be a regular, non-symlink file');
  if (stat.size > MAX_POLICY_BYTES) throw new Error('Strategy seed exceeds byte limit');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_POLICY_BYTES) throw new Error('Strategy seed exceeds byte limit');
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Strategy seed must use UTF-8 without BOM');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Strategy seed is not valid UTF-8');
  }
  if (!text.trim()) throw new Error('Strategy seed is empty');
  return { file: STRATEGY_SEED_FILE, text, bytes: bytes.length, words: text.trim().split(/\s+/u).length, sha256: sha256(bytes) };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error('Usage: node v2/agent/build-prompt.js [--check]');
    }
    const bundle = buildPrompt();
    if (args[0] === '--check') {
      const { text, ...metadata } = bundle;
      const { text: seedText, ...seedMetadata } = loadStrategySeed();
      process.stdout.write(JSON.stringify({ ...metadata, strategy_seed: seedMetadata }, null, 2) + '\n');
    } else {
      process.stdout.write(bundle.text);
    }
  } catch (error) {
    process.stderr.write(`V2 prompt assembly failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildPrompt, loadStrategySeed, POLICY_FILES, STRATEGY_SEED_FILE, MAX_POLICY_BYTES, MAX_BUNDLE_BYTES };
