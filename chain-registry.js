'use strict';

const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ZERO_EVM_ADDRESS = `0x${'0'.repeat(40)}`;

const CHAIN_CONFIG = Object.freeze({
    solana: Object.freeze({
        id: 'solana',
        aliases: Object.freeze(['solana', 'sol']),
        gmgn_namespace: 'sol',
        address_kind: 'SOLANA_BASE58',
        native_asset: 'SOL',
        market_providers: Object.freeze({ gmgn: true, mobula: true, helius: true })
    }),
    robinhood: Object.freeze({
        id: 'robinhood',
        aliases: Object.freeze(['robinhood', 'hood']),
        gmgn_namespace: 'robinhood',
        address_kind: 'EVM',
        native_asset: 'ETH',
        market_providers: Object.freeze({ gmgn: true, mobula: false, helius: false })
    })
});

const CHAIN_ALIASES = new Map();
for (const config of Object.values(CHAIN_CONFIG)) {
    for (const alias of config.aliases) CHAIN_ALIASES.set(alias, config.id);
}

function resolveChainId(value) {
    const alias = String(value || '').trim().toLowerCase();
    const chain = CHAIN_ALIASES.get(alias);
    if (!chain) throw new Error(`Unsupported chain: ${value || 'missing'}`);
    return chain;
}

function getChainConfig(value) {
    return CHAIN_CONFIG[resolveChainId(value)];
}

function isSolanaMint(value) {
    const mint = String(value || '').trim();
    if (!SOLANA_MINT_PATTERN.test(mint)) return false;

    const bytes = [0];
    for (const char of mint) {
        const digit = BASE58_ALPHABET.indexOf(char);
        if (digit < 0) return false;
        let carry = digit;
        for (let index = 0; index < bytes.length; index += 1) {
            const byteValue = bytes[index] * 58 + carry;
            bytes[index] = byteValue & 0xff;
            carry = byteValue >> 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (let index = 0; index < mint.length - 1 && mint[index] === '1'; index += 1) {
        bytes.push(0);
    }
    return bytes.length === 32;
}

function isEvmAddress(value) {
    const address = String(value || '').trim();
    return EVM_ADDRESS_PATTERN.test(address) && address.toLowerCase() !== ZERO_EVM_ADDRESS;
}

function normalizeAddress(chainValue, addressValue) {
    const chain = resolveChainId(chainValue);
    const address = String(addressValue || '').trim();
    if (chain === 'solana') {
        if (!isSolanaMint(address)) throw new Error(`Invalid Solana mint: ${address || 'missing'}`);
        return address;
    }
    if (!isEvmAddress(address)) throw new Error(`Invalid Robinhood EVM address: ${address || 'missing'}`);
    return address.toLowerCase();
}

function makeCoinId(chainValue, addressValue) {
    const chain = resolveChainId(chainValue);
    return `${chain}:${normalizeAddress(chain, addressValue)}`;
}

function parseCoinId(value) {
    const text = String(value || '').trim();
    const separator = text.indexOf(':');
    if (separator <= 0) throw new Error(`Invalid coin_id: ${text || 'missing'}`);
    const chain = resolveChainId(text.slice(0, separator));
    const address = normalizeAddress(chain, text.slice(separator + 1));
    return createCoinIdentity(chain, address);
}

function createCoinIdentity(chainValue, addressValue, options = {}) {
    const chain = resolveChainId(chainValue);
    const config = CHAIN_CONFIG[chain];
    const addressOriginal = String(options.addressOriginal || addressValue || '').trim();
    const address = normalizeAddress(chain, addressValue);
    return {
        coin_id: `${chain}:${address}`,
        chain,
        gmgn_chain: config.gmgn_namespace,
        address,
        address_original: addressOriginal || address,
        address_kind: config.address_kind,
        native_asset: config.native_asset,
        // `mint` is a compatibility alias for old Solana consumers only.
        mint: chain === 'solana' ? address : null
    };
}

function normalizeCoinReference(value, options = {}) {
    if (value && typeof value === 'object') {
        if (value.coin_id) return parseCoinId(value.coin_id);
        const chain = value.chain || value.gmgn_chain || options.defaultChain;
        const address = value.address || value.mint || value.token_mint;
        return createCoinIdentity(chain, address, {
            addressOriginal: value.address_original || address
        });
    }

    const text = String(value || '').trim();
    if (text.includes(':')) return parseCoinId(text);
    if (options.defaultChain) return createCoinIdentity(options.defaultChain, text);
    if (isSolanaMint(text)) {
        return {
            ...createCoinIdentity('solana', text),
            identity_inferred_from_legacy_mint: true
        };
    }
    if (isEvmAddress(text)) {
        throw new Error('An EVM address requires an explicit chain; refusing to infer Robinhood from address shape');
    }
    throw new Error(`Invalid token reference: ${text || 'missing'}`);
}

function gmgnTokenUrl(value, options = {}) {
    const identity = normalizeCoinReference(value, options);
    return `https://gmgn.ai/${identity.gmgn_chain}/token/${identity.address}`;
}

function gmgnAddressUrl(chainValue, addressValue) {
    const chain = resolveChainId(chainValue);
    const address = chain === 'solana'
        ? normalizeAddress(chain, addressValue)
        : String(addressValue || '').trim().toLowerCase();
    if (!address) throw new Error('Address is required');
    return `https://gmgn.ai/${CHAIN_CONFIG[chain].gmgn_namespace}/address/${address}`;
}

function providerApplicability(chainValue, provider) {
    const config = getChainConfig(chainValue);
    const key = String(provider || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(config.market_providers, key)) {
        throw new Error(`Unknown market provider: ${provider || 'missing'}`);
    }
    return config.market_providers[key]
        ? { status: 'APPLICABLE', chain: config.id, provider: key.toUpperCase() }
        : {
            status: 'NOT_APPLICABLE',
            reason: 'UNSUPPORTED_CHAIN',
            chain: config.id,
            provider: key.toUpperCase()
        };
}

module.exports = {
    CHAIN_CONFIG,
    SOLANA_MINT_PATTERN,
    EVM_ADDRESS_PATTERN,
    ZERO_EVM_ADDRESS,
    resolveChainId,
    getChainConfig,
    isSolanaMint,
    isEvmAddress,
    normalizeAddress,
    makeCoinId,
    parseCoinId,
    createCoinIdentity,
    normalizeCoinReference,
    gmgnTokenUrl,
    gmgnAddressUrl,
    providerApplicability
};
