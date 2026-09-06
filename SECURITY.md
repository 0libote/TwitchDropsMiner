# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main` (pre-release) | ✅ |
| Latest prerelease (`latest` tag) | ✅ |
| Older prereleases | ❌ |

This is a pre-release fork. Security fixes are applied to `main` and included in the next `latest` prerelease and container image.

## Reporting a Vulnerability

**Do not open a public issue for sensitive security reports.**

- Email the maintainer via the GitHub profile or use **Security → Report a vulnerability** on this repository.
- Include: affected version/commit, reproduction steps, and impact.

We will acknowledge within 72 hours and aim to ship a fix to `main` within 7 days. You will be credited if you wish.

## Dashboard Hardening

- Keep `TDM_DATA_DIR` / Docker volume private — it contains Twitch `auth-token` cookies.
- If you expose the dashboard beyond `127.0.0.1`, set `TDM_WEB_TOKEN` and `TDM_PUBLIC_URL`, and terminate TLS at your reverse proxy.
- Dashboard writes require `X-CSRF-Token` from `GET /api/csrf` and an `Origin` check; see `README.md` for proxy requirements.
- Webhook URLs and proxy credentials are never exported via `/api/export`.

## Upstream

Twitch private APIs change without notice. This fork tracks upstream via `.upstream-base` and the weekly **Upstream watch** workflow but does not auto-merge protocol changes.
