'use strict';

// D-32: descriptive statistics over returned records, never an X-wide rate.
// No I/O. Evidence arrays are neither edited, sorted, filtered nor deduplicated.
function searchProduct(value) {
    if (typeof value !== 'string') return null;
    if (value.toLowerCase() === 'top') return 'Top';
    if (value.toLowerCase() === 'latest') return 'Latest';
    return null;
}

function postId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function handleOf(post) {
    const value = post?.author?.handle ?? post?.handle;
    if (typeof value !== 'string') return null;
    const handle = value.replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function postTime(value) {
    if (typeof value !== 'string') return null;
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!parts) return null;
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

function sampleActivity(records, {
    kind = 'search', requestedProduct = null, reportedProduct = null,
    selection = 'UNKNOWN', selectionSource = 'UNKNOWN', limit = null,
    nowMs = Date.now(), collectedAt = null,
} = {}) {
    const clockValid = Number.isFinite(nowMs) && Number.isFinite(new Date(nowMs).getTime());
    const collectedMs = postTime(collectedAt);
    // Missing collection time may use the current response's receipt time, but
    // a supplied invalid/future source timestamp must never be relabelled fresh.
    const timeValid = clockValid && (collectedAt == null || (collectedMs !== null && collectedMs <= nowMs));
    const asOfMs = timeValid ? (collectedAt == null ? nowMs : collectedMs) : null;
    const validArray = Array.isArray(records);
    const summary = {
        version: 1, kind, scope: 'RETURNED_RECORDS_ONLY',
        population_coverage: 'NON_EXHAUSTIVE',
        requested_product: searchProduct(requestedProduct),
        reported_product: searchProduct(reportedProduct),
        selection, selection_source: selectionSource,
        collected_at: asOfMs === null ? null : new Date(asOfMs).toISOString(),
        collection_time_source: collectedAt == null ? 'RESPONSE_RECEIPT' : 'PROVIDER_REPORTED',
        requested_limit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
        status: !validArray ? 'UNAVAILABLE' : records.length ? 'OBSERVED_SAMPLE' : 'EMPTY_SAMPLE',
        raw_record_count: validArray ? records.length : null,
        distinct_post_count: validArray ? 0 : null,
        duplicate_capture_count: validArray ? 0 : null,
        records_without_exact_id: validArray ? 0 : null,
        conflicting_post_count: validArray ? 0 : null,
        dated_distinct_post_count: validArray ? 0 : null,
        unbucketed_distinct_post_count: validArray ? 0 : null,
        observed_unique_authors: null,
        max_observed_author_followers: null, top_observed_author_followers: [],
        observed_posts_last_30m: null, observed_posts_prior_30m: null,
        observed_posts_older: null,
        temporal_coverage: 'UNAVAILABLE',
        acceleration_hint: null, acceleration_status: 'UNAVAILABLE_NON_EXHAUSTIVE_SAMPLE',
        reasons: ['Returned samples do not measure complete-period or X-wide demand.'],
    };
    if (!validArray) {
        summary.reasons.push('No returned record array.');
        return summary;
    }
    if (!timeValid) summary.reasons.push('Collection timestamp or clock is invalid/future.');
    const groups = new Map();
    for (const record of records) {
        const id = postId(record?.id);
        if (!id) { summary.records_without_exact_id++; continue; }
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(record);
    }
    summary.distinct_post_count = groups.size;
    const authorFollowers = new Map();
    const authors = new Set();
    let recent = 0, prior = 0, older = 0;
    for (const copies of groups.values()) {
        summary.duplicate_capture_count += copies.length - 1;
        const handles = new Set(copies.map(handleOf).filter(Boolean));
        const dates = copies.map(post => postTime(post?.date));
        const knownDates = new Set(dates.filter(time => time !== null));
        const conflict = handles.size > 1 || knownDates.size > 1;
        if (conflict) summary.conflicting_post_count++;
        if (!conflict && handles.size === 1) {
            const handle = [...handles][0];
            authors.add(handle);
            for (const copy of copies) {
                const followers = copy?.author?.followers ?? copy?.followers;
                if (!Number.isSafeInteger(followers) || followers < 0) continue;
                authorFollowers.set(handle, Math.max(authorFollowers.get(handle) ?? followers, followers));
            }
        }
        const time = dates[0];
        if (!timeValid || conflict || dates.some(date => date === null) || time > asOfMs) {
            summary.unbucketed_distinct_post_count++;
            continue;
        }
        summary.dated_distinct_post_count++;
        const ageMs = asOfMs - time;
        if (ageMs <= 30 * 60000) recent++;
        else if (ageMs <= 60 * 60000) prior++;
        else older++;
    }
    if (authors.size) summary.observed_unique_authors = authors.size;
    const followers = [...authorFollowers.values()].sort((a, b) => b - a);
    summary.max_observed_author_followers = followers.length ? followers[0] : null;
    summary.top_observed_author_followers = followers.slice(0, 5);
    if (summary.dated_distinct_post_count > 0) {
        summary.observed_posts_last_30m = recent;
        summary.observed_posts_prior_30m = prior;
        summary.observed_posts_older = older;
        summary.temporal_coverage = 'DATED_SAMPLE_ONLY';
    }
    if (summary.records_without_exact_id || summary.unbucketed_distinct_post_count) {
        summary.status = 'PARTIAL_OBSERVATION_SAMPLE';
        summary.reasons.push('Missing/conflicting identity or missing/invalid/future dates exclude records from time buckets.');
    }
    return summary;
}

// Normalize even old/alternative service responses using their actual returned
// records. Never adopt their legacy velocity or claim the requested tab loaded.
function withSampleActivity(response, { kind, requestedProduct = null, limit = null, nowMs = Date.now() } = {}) {
    if (!response || response.ok !== true) return response;
    const isSearch = kind === 'search';
    const reported = isSearch ? searchProduct(response.product) : null;
    const providerSelection = response.sample_activity;
    const expected = isSearch && reported
        ? (reported === 'Latest' ? 'LATEST_SELECTED' : 'TOP_RELEVANCE_SELECTED')
        : kind === 'community' ? 'UNKNOWN_VIEW_LOCALLY_DATE_SORTED' : 'UNKNOWN';
    const browserSelection = providerSelection?.version === 1
        && providerSelection.selection_source === 'X_BROWSER_NAVIGATION'
        && providerSelection.selection === expected;
    const collectedAt = providerSelection && Object.hasOwn(providerSelection, 'collected_at')
        ? providerSelection.collected_at ?? 'UNAVAILABLE_PROVIDER_COLLECTION_TIME'
        : response.fetched_at ?? null;
    return {
        ...response,
        velocity: null,
        sample_activity: sampleActivity(isSearch ? response.tweets : response.posts, {
            kind, requestedProduct, reportedProduct: reported, limit, nowMs, collectedAt,
            selection: browserSelection ? expected : isSearch && reported ? `${reported.toUpperCase()}_PROVIDER_REPORTED` : 'UNKNOWN',
            selectionSource: browserSelection ? 'X_BROWSER_NAVIGATION' : reported ? 'PROVIDER_REPORTED' : 'UNKNOWN',
        }),
    };
}

module.exports = { searchProduct, sampleActivity, withSampleActivity };
