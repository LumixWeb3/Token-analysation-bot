'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getChainConfig } = require('./chain-registry');

const DEFAULT_ROOT = path.resolve(__dirname, 'runtime-browser-profiles');
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_AFTER_MS = 2 * 60_000;

function safeName(value, label) {
    const text = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(text)) throw new Error(`${label} contains unsafe characters`);
    return text;
}

function profileDirectory({ rootDir = DEFAULT_ROOT, role, chain, profileName }) {
    const config = getChainConfig(chain);
    const safeRole = safeName(role, 'browser profile role');
    const resolvedRoot = path.resolve(rootDir);
    const directory = path.resolve(resolvedRoot, profileName ? safeName(profileName, 'browser profile name') : `${safeRole}-${config.id}`);
    const relative = path.relative(resolvedRoot, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('browser profile escaped its root');
    return directory;
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function acquireProfileLock(directory, {
    now = () => Date.now(),
    pid = process.pid,
    heartbeatMs = LOCK_HEARTBEAT_MS,
    staleAfterMs = LOCK_STALE_AFTER_MS
} = {}) {
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, 'alphahands-profile.lock');
    const token = crypto.randomUUID();

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            try {
                const acquiredAt = new Date(now()).toISOString();
                fs.writeFileSync(fd, JSON.stringify({
                    schema_version: 'gmgn-profile-lock.v1',
                    pid,
                    token,
                    acquired_at: acquiredAt,
                    heartbeat_at: acquiredAt
                }));
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            let released = false;
            const heartbeat = setInterval(() => {
                if (released) return;
                try {
                    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                    if (current.token !== token) return;
                    const temporary = `${lockPath}.${pid}.${token}.tmp`;
                    fs.writeFileSync(temporary, JSON.stringify({
                        ...current,
                        heartbeat_at: new Date(now()).toISOString()
                    }));
                    fs.renameSync(temporary, lockPath);
                } catch (_) { /* the next owner performs the fail-closed check */ }
            }, Math.max(1_000, Number(heartbeatMs) || LOCK_HEARTBEAT_MS));
            heartbeat.unref?.();
            return {
                path: lockPath,
                token,
                release() {
                    if (released) return;
                    released = true;
                    clearInterval(heartbeat);
                    try {
                        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                        if (current.token === token) fs.unlinkSync(lockPath);
                    } catch (_) {}
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let existing = null;
            try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
            const lastHeartbeatMs = Date.parse(existing?.heartbeat_at || existing?.acquired_at);
            const lockFresh = Number.isFinite(lastHeartbeatMs) && now() - lastHeartbeatMs <= staleAfterMs;
            if (existing && processIsAlive(Number(existing.pid)) && lockFresh) {
                throw new Error(`GMGN browser profile is already owned by live process ${existing.pid}`);
            }
            // A crashed process can leave only this narrow lock file behind.
            // PID numbers are reused on Windows, so an old lock is also stale
            // when its owner heartbeat stopped even if that PID now exists.
            try { fs.unlinkSync(lockPath); } catch (unlinkError) {
                throw new Error(`Could not reclaim stale GMGN browser profile lock: ${unlinkError.message}`);
            }
        }
    }
    throw new Error('Could not acquire GMGN browser profile lock');
}

async function launchManagedPersistentContext({
    chromium,
    role,
    chain,
    rootDir = DEFAULT_ROOT,
    profileName,
    headless = true,
    viewport = { width: 1440, height: 1400 },
    userAgent,
    args = []
} = {}) {
    if (!chromium?.launchPersistentContext) throw new Error('Playwright chromium is required');
    const directory = profileDirectory({ rootDir, role, chain, profileName });
    const lock = acquireProfileLock(directory);
    let context = null;
    try {
        context = await chromium.launchPersistentContext(directory, {
            channel: 'chrome',
            headless,
            viewport,
            userAgent,
            args
        });
        const existingPages = context.pages();
        const page = existingPages[0] || await context.newPage();
        let closed = false;
        return {
            context,
            page,
            chain: getChainConfig(chain).id,
            role: safeName(role, 'browser profile role'),
            profile_dir: directory,
            async close() {
                if (closed) return;
                closed = true;
                try { await context.close(); } finally { lock.release(); }
            }
        };
    } catch (error) {
        try { if (context) await context.close(); } catch (_) {}
        lock.release();
        throw error;
    }
}

module.exports = {
    DEFAULT_ROOT,
    LOCK_HEARTBEAT_MS,
    LOCK_STALE_AFTER_MS,
    profileDirectory,
    acquireProfileLock,
    launchManagedPersistentContext,
    _internal: { safeName, processIsAlive }
};
