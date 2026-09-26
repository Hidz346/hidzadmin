/* Vercel Firewall edge-event synchronizer.
 *
 * This runs from the existing HidzAdmin security dashboard endpoint, so it
 * does not add another Vercel Function. It pulls recent Firewall actions for
 * both HidzAdmin and HidzProject and mirrors a normalized copy into the same
 * hidz_security_events node the dashboard already reads.
 *
 * Edge Firewall data can contain IP/host/action/count, but the Firewall
 * actions API does not expose street-level location. Location remains
 * best-effort and is filled by the application security guard when a request
 * reaches a Function.
 */
var crypto = require('crypto');
var db = require('./db');

var API_URL = 'https://api.vercel.com/v1/security/firewall/events';
var SYNC_STATE_PATH = 'hidz_security_edge_sync_state';
var SYNC_TTL_MS = 20 * 1000;
var LOOKBACK_MS = 10 * 60 * 1000;

var DEFAULT_TEAM_ID = 'team_5TUrQha6Mlc7AacaibCGRvY0';

var PROJECTS = [
    {
        name: 'HidzAdmin',
        id: process.env.HIDZADMIN_VERCEL_PROJECT_ID || 'prj_0OJRpG2f2Z2sSkLCCdbdgoIlpMyR'
    },
    {
        name: 'HidzProject',
        id: process.env.HIDZPROJECT_VERCEL_PROJECT_ID || 'prj_9madBIDyyxb16lKiezNc9sXcKIA7'
    }
];

function clean(value, max) {
    return String(value == null ? '' : value).slice(0, max || 240);
}

function parseTime(value, fallback) {
    if (value == null || value === '') return fallback;
    var n = Number(value);
    if (Number.isFinite(n)) {
        if (n < 100000000000) n *= 1000;
        return n;
    }
    var parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function severityForAction(action) {
    var value = String(action || '').toLowerCase();
    if (/ddos|attack|anomaly/.test(value)) return 'critical';
    if (/deny|rate.?limit|challenge|block/.test(value)) return 'high';
    return 'medium';
}

function isDdosLike(action) {
    return /ddos|attack|anomaly/.test(String(action || '').toLowerCase());
}

function eventId(project, action) {
    var stable = [
        project.id,
        action.action_type || '',
        action.startTime || '',
        action.host || '',
        action.public_ip || ''
    ].join('|');

    return 'edge_' + crypto.createHash('sha256').update(stable).digest('hex').slice(0, 48);
}

async function fetchActions(project, token, teamId, now) {
    var start = now - LOOKBACK_MS;
    var end = now;

    var url = API_URL +
        '?projectId=' + encodeURIComponent(project.id) +
        '&teamId=' + encodeURIComponent(teamId) +
        '&startTimestamp=' + encodeURIComponent(String(start)) +
        '&endTimestamp=' + encodeURIComponent(String(end));

    var response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        /* Some API versions/accounts may reject the optional timestamp
           parameters. Retry with the minimal documented request rather than
           making the dashboard fail. */
        var fallback = await fetch(
            API_URL +
            '?projectId=' + encodeURIComponent(project.id) +
            '&teamId=' + encodeURIComponent(teamId),
            {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer ' + token,
                    Accept: 'application/json'
                }
            }
        );

        if (!fallback.ok) {
            return {
                ok: false,
                error: 'VERCEL_FIREWALL_API_' + fallback.status,
                actions: []
            };
        }

        var fallbackData = await fallback.json();
        return {
            ok: true,
            actions: Array.isArray(fallbackData.actions) ? fallbackData.actions : []
        };
    }

    var data = await response.json();
    return {
        ok: true,
        actions: Array.isArray(data.actions) ? data.actions : []
    };
}

async function syncProject(project, token, teamId, now) {
    var result = await fetchActions(project, token, teamId, now);
    if (!result.ok) return result;

    var saved = 0;
    var actions = result.actions;

    for (var i = 0; i < actions.length; i++) {
        var action = actions[i] || {};
        var actionType = clean(action.action_type || action.actionType || 'firewall_action', 80);
        var startedAt = parseTime(action.startTime, now);
        var endedAt = parseTime(action.endTime, startedAt);
        var active = action.isActive === true || String(action.isActive).toLowerCase() === 'true';
        var publicIp = clean(action.public_ip || action.publicIp || '', 96);
        var host = clean(action.host || '', 220);
        var count = Number(action.count || 0);
        if (!Number.isFinite(count) || count < 0) count = 0;

        var event = {
            ip: publicIp || 'Tidak diketahui',
            attemptAt: startedAt,
            endpoint: host ? 'edge://' + host : 'edge://firewall',
            method: 'EDGE',
            reason: 'Vercel Firewall: ' + actionType +
                (count ? ' (' + count + ' request)' : ''),
            userAgent: '',
            referer: '',
            origin: '',
            host: host,
            requestId: '',
            contentLength: '',
            source: 'vercel_firewall',
            project: project.name,
            eventType: isDdosLike(actionType) ? 'ddos_edge_event' : 'edge_firewall_event',
            severity: severityForAction(actionType),
            requestCount: count,
            actionType: actionType,
            active: active,
            edgeStartTime: startedAt,
            edgeEndTime: endedAt,
            location: {
                country: 'Tidak tersedia dari Firewall API',
                region: 'Tidak tersedia',
                city: 'Tidak tersedia',
                latitude: '',
                longitude: '',
                timezone: '',
                mapsUrl: ''
            }
        };

        var id = eventId(project, action);
        var savedOk = await db.setPath('hidz_security_events/' + id, event);
        if (savedOk) saved++;
    }

    return {
        ok: true,
        fetched: actions.length,
        saved: saved
    };
}

async function sync() {
    var token = process.env.VERCEL_API_TOKEN || '';
    if (!token) {
        return {
            ok: false,
            enabled: false,
            reason: 'VERCEL_API_TOKEN_NOT_CONFIGURED'
        };
    }

    var teamId = process.env.VERCEL_TEAM_ID || DEFAULT_TEAM_ID;
    var now = Date.now();

    var state = await db.fetchPath(SYNC_STATE_PATH);
    if (state && state.lastSyncAt && now - Number(state.lastSyncAt) < SYNC_TTL_MS) {
        return {
            ok: true,
            skipped: true,
            lastSyncAt: Number(state.lastSyncAt)
        };
    }

    var results = [];
    for (var i = 0; i < PROJECTS.length; i++) {
        try {
            results.push(Object.assign({
                project: PROJECTS[i].name
            }, await syncProject(PROJECTS[i], token, teamId, now)));
        } catch (e) {
            results.push({
                project: PROJECTS[i].name,
                ok: false,
                error: 'SYNC_FAILED'
            });
        }
    }

    await db.setPath(SYNC_STATE_PATH, {
        lastSyncAt: now,
        source: 'vercel_firewall_api'
    });

    return {
        ok: true,
        skipped: false,
        syncedAt: now,
        results: results
    };
}

module.exports = {
    sync: sync
};
