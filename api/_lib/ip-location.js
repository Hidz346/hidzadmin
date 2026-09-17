/* Best-effort IP location from trusted edge headers.
 * Vercel adds these headers at the edge for incoming requests. The result is
 * approximate (city/region level), not a physical street address.
 */
function header(req, name) {
    var h = (req && req.headers) || {};
    var value = h[name] || h[name.toLowerCase()];
    return value == null ? '' : String(value).trim();
}

function clean(value, max) {
    value = String(value || '').trim();
    return value.slice(0, max || 120);
}

function clientLocation(req) {
    var country = clean(header(req, 'x-vercel-ip-country') || header(req, 'cf-ipcountry'), 16);
    var region = clean(header(req, 'x-vercel-ip-country-region'), 80);
    var city = clean(header(req, 'x-vercel-ip-city'), 120);
    var latitude = clean(header(req, 'x-vercel-ip-latitude'), 32);
    var longitude = clean(header(req, 'x-vercel-ip-longitude'), 32);
    var timezone = clean(header(req, 'x-vercel-ip-timezone'), 80);

    var latNum = Number(latitude);
    var lonNum = Number(longitude);
    var hasCoords = Number.isFinite(latNum) && Number.isFinite(lonNum) && latNum >= -90 && latNum <= 90 && lonNum >= -180 && lonNum <= 180;
    var mapsUrl = hasCoords
        ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(latNum + ',' + lonNum)
        : '';

    return {
        country: country || 'Tidak diketahui',
        region: region || 'Tidak diketahui',
        city: city || 'Tidak diketahui',
        latitude: latitude || '',
        longitude: longitude || '',
        timezone: timezone || '',
        mapsUrl: mapsUrl
    };
}

module.exports = clientLocation;
