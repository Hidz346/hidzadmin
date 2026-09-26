# HidzAdmin — Vercel Firewall Production Setup

HidzAdmin uses two security layers:

1. Vercel Firewall at the edge for volumetric and request-level abuse.
2. Server-side protection in `api/_lib/security.js` plus the admin login lockout in `api/_lib/db.js`.

Do not replace the edge layer with JavaScript rate limiting. The application guard is defense in depth only.

## 1. Automatic DDoS protection

Vercel provides platform-level DDoS mitigation automatically for deployed projects. No application code is required for this layer.

## 2. Hobby-plan firewall layout

The current Vercel firewall supports custom rules on Hobby. Current Hobby limits are three custom firewall rules per project and one rate-limiting rule per project. Bot Protection is available as a managed ruleset. The OWASP Core Ruleset is not available on Hobby.

Because HidzAdmin is on the Hobby plan, keep the configuration within those limits. Do not create two separate rate-limit rules.

## 3. Rule 1 — Admin API rate limit

Create one custom rule:

- Name: `HIDZ Admin Abuse`
- Match: `POST` requests to `/api/admin-login` OR `/api/admin/`
- Rate limit: `20 requests / 60 seconds / IP`
- Exceeded action: `429`
- Keep the rule active and publish it.

The rule intentionally targets only authentication and privileged admin routes. Do not rate-limit all of `/api/*`: the admin panel may legitimately make several API requests during normal use.

The server also has a separate credential lockout after repeated failed admin authentication attempts, so the two layers are complementary.

## 4. Rule 2 — common scanner paths

Create one blocking rule for obvious probes that are not part of HidzAdmin:

- `/.env`
- `/.git/`
- `/wp-admin`
- `/wp-login.php`
- `/xmlrpc.php`
- `/phpmyadmin`
- `/server-status`
- `/cgi-bin/`

Action: `Deny`.

Keep this rule path-based. Do not block generic words such as `select`, `union`, or `script` globally because those can create unnecessary false positives on normal traffic.

## 5. Rule 3 — bot protection

Enable Vercel's **Bot Protection** managed ruleset for the project.

Use challenge behavior for suspicious automated traffic where Vercel exposes the option. Do not blanket-block every non-browser user agent because legitimate uptime monitors and API tools may use them.

## 6. Managed OWASP rules

Do not rely on the OWASP Core Ruleset on Hobby because it is not available on this plan.

HidzAdmin therefore keeps the existing application-layer injection detector in `api/_lib/security.js`. It detects SQL-injection patterns, script/XSS patterns, path traversal, and command-style payloads and temporarily blocks abusive IPs.

This remains defense in depth; it is not the DDoS boundary.

## 7. Attack Challenge Mode

Use **Attack Challenge Mode** only during an active attack or severe abuse spike. It is an emergency control and should not replace the normal firewall rules.

## 8. Emergency IP blocking

Use **Firewall → IP Blocking** for confirmed abusive IP addresses.

Do not permanently block normal users based only on a single 429 response.

## 9. Production verification

After publishing firewall changes:

1. Open `hidzadmin.vercel.app` or the custom domain normally.
2. Perform one valid admin login.
3. Perform one invalid login and confirm the application still returns its normal response.
4. Open the admin panel and load the account list.
5. Confirm create, extend/reduce, delete, logout, and security-event actions still work.
6. Watch Firewall traffic for unexpected blocks.
7. Check the latest production deployment for 4xx/5xx spikes.

Do not flood the production domain to test DDoS protection.

## 10. CSP note

The admin deployment uses CSP Report-Only without a report endpoint. This is intentional: creating a separate CSP-report Serverless Function would add another Vercel Function and can reintroduce the Hobby function-count limit that this project previously hit.


## 11. Edge firewall incident mirroring

The existing `api/admin/security-alerts.js` now synchronizes recent Vercel Firewall actions for both projects into the shared `hidz_security_events` node. This does **not** add another Serverless Function and does **not** modify the obfuscated `index.html`.

Configure these Vercel environment variables in HidzAdmin:

- `VERCEL_API_TOKEN` — server-only Vercel API token with permission to read Firewall data.
- `VERCEL_TEAM_ID` — optional; defaults to the current Hidz team.
- `HIDZADMIN_VERCEL_PROJECT_ID` — optional; defaults to the current HidzAdmin project ID.
- `HIDZPROJECT_VERCEL_PROJECT_ID` — optional; defaults to the current HidzProject project ID.

The synchronized edge record can contain:

- public IP
- host
- Firewall action type
- request count
- start/end time
- project name
- active/observed state
- severity

The Firewall actions API does not provide a physical address. Edge events therefore show location as unavailable when the request never reaches an application Function. Application-layer events continue to use Vercel location headers for approximate country/region/city/coordinates.

On Hobby, this is a dashboard-driven synchronization fallback rather than a guaranteed real-time push webhook. Vercel's edge mitigation remains the primary DDoS protection boundary.
