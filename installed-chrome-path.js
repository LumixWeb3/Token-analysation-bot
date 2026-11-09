'use strict';

const fs = require('fs');
const path = require('path');

function findChromePath({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
    const candidates = platform === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
        : platform === 'win32'
            ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
                .filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            : [];
    return candidates.find(candidate => exists(candidate)) || null;
}

module.exports = { findChromePath };
