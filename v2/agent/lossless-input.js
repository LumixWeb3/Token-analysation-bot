'use strict';

// Repeated source values are sent once through ordinary JSON references. The
// authoritative packet and every array occurrence remain reconstructible.
const { hash } = require('../market/network-feed');
const MAX_PACKET_BYTES = 32 * 1024 * 1024;
const referenceNode = value => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === 1 && Object.hasOwn(value, '$ref');
const literalNode = value => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === 1 && Object.hasOwn(value, '$object');
const tableNode = value => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === 1 && Object.hasOwn(value, '$table');

function prepareModelInput(packet) {
  const original = JSON.stringify(packet);
  const originalBytes = Buffer.byteLength(original);
  if (originalBytes > MAX_PACKET_BYTES) throw Error('RESEARCH_INPUT_OVERSIZE_NO_TRUNCATION');
  const occurrences = new Map();
  function candidate(value) {
    if (typeof value === 'string') return value.length >= 128;
    return value !== null && typeof value === 'object';
  }
  function count(value) {
    if (candidate(value)) {
      const serialized = JSON.stringify(value);
      if (serialized.length >= 128) occurrences.set(serialized, (occurrences.get(serialized) ?? 0) + 1);
    }
    if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === 'object') Object.values(value).forEach(count);
  }
  count(packet);
  const values = {}, identifiers = new Map();
  function encodeChildren(value) {
    if (Array.isArray(value)) {
      const first = value[0];
      if (value.length >= 3 && first && !Array.isArray(first) && typeof first === 'object') {
        const columns = Object.keys(first);
        const signature = JSON.stringify(columns);
        if (columns.length && value.every(row => row && !Array.isArray(row) && typeof row === 'object' &&
          JSON.stringify(Object.keys(row)) === signature && columns.every(key => row[key] !== undefined) &&
          (occurrences.get(JSON.stringify(row)) ?? 0) < 2))
          return { $table: { columns, rows: value.map(row => columns.map(key => encode(row[key]))) } };
      }
      return value.map(encode);
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => [key, encode(child)]);
      return referenceNode(value) || literalNode(value) || tableNode(value) ? { $object: entries } : Object.fromEntries(entries);
    }
    return value;
  }
  function encode(value) {
    if (candidate(value)) {
      const serialized = JSON.stringify(value);
      if ((occurrences.get(serialized) ?? 0) > 1) {
        let identifier = identifiers.get(serialized);
        if (identifier === undefined) {
          identifier = 'e' + identifiers.size;
          identifiers.set(serialized, identifier);
          values[identifier] = encodeChildren(value);
        }
        return { $ref: '#/values/' + identifier };
      }
    }
    return encodeChildren(value);
  }
  const envelope = {
    schema: 'alphahands.lossless-json.v1',
    original_packet_sha256: hash(packet), original_bytes: originalBytes,
    value: encode(packet), values
  };
  const encoded = JSON.stringify(envelope);
  const encodedBytes = Buffer.byteLength(encoded);
  const compressed = encodedBytes < originalBytes;
  const text = compressed ? encoded : original;
  // Independently reconstruct before passing the representation to the model.
  if (compressed && JSON.stringify(restoreModelInput(envelope)) !== original)
    throw Error('RESEARCH_INPUT_LOSSLESS_CHECK_FAILED');
  return {
    text,
    manifest: { mode: compressed ? envelope.schema : 'ORIGINAL_JSON', original_bytes: originalBytes,
      delivered_bytes: Buffer.byteLength(text), original_packet_sha256: envelope.original_packet_sha256,
      shared_values: compressed ? Object.keys(values).length : 0 }
  };
}

function restoreModelInput(envelope) {
  if (envelope?.schema !== 'alphahands.lossless-json.v1' || !envelope.values ||
      !Number.isSafeInteger(envelope.original_bytes) || envelope.original_bytes < 0 ||
      envelope.original_bytes > MAX_PACKET_BYTES) throw Error('RESEARCH_INPUT_REFERENCE_INVALID');
  const active = new Set(), restored = new Map();
  function decode(value) {
    if (referenceNode(value)) {
      const identifier = typeof value.$ref === 'string' && /^#\/values\/(e\d+)$/.exec(value.$ref)?.[1];
      if (!identifier || !Object.hasOwn(envelope.values, identifier) || active.has(identifier))
        throw Error('RESEARCH_INPUT_REFERENCE_INVALID');
      if (restored.has(identifier)) return restored.get(identifier);
      active.add(identifier);
      const result = decode(envelope.values[identifier]);
      active.delete(identifier);
      restored.set(identifier, result);
      return result;
    }
    if (literalNode(value)) {
      if (!Array.isArray(value.$object) || value.$object.some(entry =>
        !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'))
        throw Error('RESEARCH_INPUT_REFERENCE_INVALID');
      return Object.fromEntries(value.$object.map(([key, child]) => [key, decode(child)]));
    }
    if (tableNode(value)) {
      const { columns, rows } = value.$table ?? {};
      if (!Array.isArray(columns) || columns.some(key => typeof key !== 'string') ||
        new Set(columns).size !== columns.length || !Array.isArray(rows) ||
        rows.some(row => !Array.isArray(row) || row.length !== columns.length))
        throw Error('RESEARCH_INPUT_REFERENCE_INVALID');
      return rows.map(row => Object.fromEntries(columns.map((key, index) => [key, decode(row[index])])));
    }
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
    return value;
  }
  const result = decode(envelope.value);
  if (Buffer.byteLength(JSON.stringify(result)) !== envelope.original_bytes || hash(result) !== envelope.original_packet_sha256)
    throw Error('RESEARCH_INPUT_REFERENCE_INTEGRITY');
  return result;
}

module.exports = { prepareModelInput, restoreModelInput, MAX_PACKET_BYTES };
