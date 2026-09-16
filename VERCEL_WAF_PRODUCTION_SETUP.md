# HIDZPROJECT — Vercel Firewall Production Setup

This project keeps application-level protection in the API and uses Vercel Firewall for the edge layer. Do not try to replace the Vercel Firewall with JavaScript rate limiting: the edge layer must stop abusive traffic before it reaches the Functions.

## 1. DDoS protection

Vercel's platform-wide DDoS mitigation is automatic for Vercel deployments. No application code is required for this layer.

## 2. Custom WAF rules

Open the Vercel project → **Firewall** → **Configure** → **Custom Rules**.

Create these rules and publish them:

### Rule A — protect authentication

- Name: `HIDZ Auth Abuse`
- Request Path: starts with `/api/login` OR equals `/api/admin-login`
- Action: **Rate Limit**
- Follow-up action: **Deny / 429**
- Start conservatively and watch the live traffic window before tightening it.

### Rule B — protect admin API

- Name: `HIDZ Admin API`
- Request Path: starts with `/api/admin/`
- Action: **Rate Limit**
- Follow-up action: **Deny / 429**

### Rule C — suspicious non-browser traffic

Use Vercel's Bot Protection / challenge capability where available. Do not blanket-block cURL or all non-browser clients because legitimate monitoring and API tooling may use them.

### Rule D — emergency IP blocking

Use Firewall → IP Blocking for confirmed abusive addresses. Do not put normal users into permanent blocks merely because of a single transient 429.

## 3. Managed rules

If the project's Vercel plan exposes managed rulesets, enable the available OWASP/bot protection rules after first observing them in log mode where supported. Review false positives before enforcing aggressive rules.

## 4. Attack Challenge Mode

Use **Attack Challenge Mode** temporarily during an active attack when normal traffic is being overwhelmed. It is a mitigation switch, not a permanent replacement for normal WAF rules.

## 5. Application layer

The project also keeps a server-side rate limiter and suspicious-input detector. This is intentionally retained as defense in depth. It should never be treated as the DDoS boundary.

## 6. Production verification

After publishing WAF changes:

1. Open the live site normally.
2. Test login once with valid credentials.
3. Test login once with an invalid credential.
4. Open the admin panel and load the account list.
5. Create/extend/delete one test account if appropriate.
6. Log out and confirm the session is invalidated.
7. Check Vercel Firewall live traffic for unexpected blocking.
8. Check Vercel deployment logs for 4xx/5xx spikes.

Do not intentionally generate a large traffic flood against the production domain to test DDoS protection.
