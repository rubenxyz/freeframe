# FreeFrame Security Audit — 2026-07-12

Scope: `rubenxyz/freeframe` fork @ `366ae61` (branch `feature/instance-branding`) +
live instance at `/opt/freeframe` on `rubenxyz` (Incus container `freeframe`,
branch `instance-rebrand` @ `ee80f87`) behind nginx → Cloudflare Tunnel at
`https://www.kamiko.xyz/freeframe/`.

Two prior security fixes are referenced:
- magic-code enumeration prevention (live STATE.md 2026-06-22 — NOT upstream yet)
- avatar upload IDOR + durable S3 key (PR #93 — open against upstream)

This audit is independent of those. Findings below are grouped by severity and
tagged with the affected file/line. "upstream" = `Techiebutler/freeframe`.
"live" = the rubenxyz instance config.

---

## 🔴 CRITICAL

### C1. `invite_token` leaked via `UserResponse` → account takeover
`apps/api/schemas/auth.py:31` exposes `invite_token: str | None` on
`UserResponse`. The `from_attributes=True` mapping reads the ORM column
directly. Two *any-authenticated-user* endpoints return `UserResponse`:

- `GET /users?ids=<user_id>,...` — `routers/users.py:18` ("Any authenticated
  user can call this")
- `GET /users/search?q=<email>` — `routers/users.py:35` (returns up to 10 hits)

An authenticated user can therefore read the **unexpired `invite_token` of any
user still in `pending_invite` status**, then call
`POST /auth/accept-invite` (`routers/auth.py:154`) with that token + a chosen
password → take over the invited user's account before the legitimate invitee
does. `UserResponse` is also returned by `/auth/refresh`, `/auth/set-password`,
every `/users/*` admin endpoint, and `/auth/me`, so the leak surface is wide.

**Fix:** drop `invite_token` (and `is_superadmin`/`email_verified` should
stay) from the public `UserResponse`; expose `invite_token` only via an
admin-scoped serializer.

### C2. Share-link password bypass on comment endpoints
`apps/api/routers/comments.py:557` (`GET /share/{token}/comments`) and
`comments.py:595` (`POST /share/{token}/comment`) call
`validate_share_link(db, token)` — which only checks the token exists, is
enabled, and is not expired (`services/permissions.py:114`). It does **not**
verify the share-link password. Compare `routers/share.py:1195`, which
correctly uses `validate_share_link_with_session` for `/share/{token}/assets`.

A guest can read all comments on, and post comments to, any
**password-protected** share link without supplying the password. The password
gate on `/share/{token}` is meaningless if the comment surface is open.

**Fix:** switch both comment endpoints to `validate_share_link_with_session`
(passing `share_session` and `current_user` exactly like
`get_folder_share_assets` does).

---

## 🟠 HIGH

### H1. Magic-code auto-creates accounts (upstream)
`apps/api/routers/auth.py:40` unconditionally creates a
`pending_verification` user (the **first** such user becomes `is_superadmin`)
when `POST /auth/send-magic-code` is called for an unknown email, then sends a
real email via Resend. Any anonymous visitor can:
- enumerate which emails have accounts (different code path/response timing),
- drain the Resend quota,
- create arbitrary `pending_verification` accounts,
- and in a fresh deployment, become the **superadmin** by being first.

Already fixed on live `instance-rebrand` (STATE.md 2026-06-22) but not
upstream. **Fix upstream** the same way: return the same response shape for
unknown emails, send nothing, create nothing.

### H2. API docs + OpenAPI schema publicly served
`apps/api/main.py:16,25-27` enables `/docs`, `/redoc`, `/openapi.json`
whenever `DISABLE_DOCS` is not set. `docker-compose.prod.yml` sets it for the
canonical deployment, but systemd/bare-metal deploys don't. **Live instance
returns 200 on `https://www.kamiko.xyz/api/docs` and `/api/openapi.json`.** The
schema enumerates the entire attack surface (every endpoint, every Pydantic
field — including `invite_token` on `UserResponse`, which amplifies C1).

**Fix (code):** log a loud startup warning when docs are enabled and
`frontend_url` is not localhost. **Fix (live):** set `DISABLE_DOCS=true` in
`/opt/freeframe/.env.freeframe` and restart `freeframe-api`.

### H3. Share-link password sent in the URL
`apps/api/routers/share.py:257` declares `password: Optional[str] = None` as a
plain function parameter on the `GET /share/{token}` endpoint. FastAPI treats
this as a **query parameter**. The frontend sends it that way
(`app/share/[token]/page.tsx:94`). Passwords in URLs are logged by nginx
access logs, browser history, Referer headers, and Cloudflare Tunnel logs,
and remain in those logs long after the share session expires.

**Fix:** introduce `POST /share/{token}/verify` accepting `{password}` in the
body; GET drops the `password` param (and only returns `requires_password:
true`). Frontend migrates to POST for the password submit.

---

## 🟡 MEDIUM

### M1. No password strength/min-length validation
`SetPasswordRequest`, `AcceptInviteRequest`, `RegisterRequest`,
`LoginRequest` (`schemas/auth.py:8,12,53,58`) and `CreateSuperAdminRequest`
(`routers/setup.py:26`) all use `password: str` with no constraints. Empty and
1-char passwords are accepted. **Fix:** add `min_length=8, max_length=72`
(that's also the bcrypt byte limit already enforced silently).

### M2. S3 public-read policy on `processed/*` is unnecessary
`apps/api/services/s3_service.py:128-148` sets a bucket policy granting
`s3:GetObject` to `*` for every key under `processed/`. The HLS proxy in
`routers/hls_proxy.py` already rewrites `.ts` segment URLs to **presigned**
S3 URLs, so public-read is dead weight. On the live instance,
`https://www.kamiko.xyz/ff-storage/processed/...` returns the object to anyone
who guesses/leaks a key (UUIDs are not secret; share-link presigned GETs
expose them). **Fix:** drop the policy; rely on presigned URLs.

### M3. `InstanceBrandingUpdate.logo_*_key` accepts arbitrary S3 keys
`apps/api/routers/instance_branding.py:114-122` `setattr`s
client-supplied `logo_*_key` values directly. The next GET then presigns GETs
for those keys — an admin-scoped arbitrary-bucket-read IDOR (any raw upload,
any private avatar). Defense-in-depth: **validate keys start with `branding/`**.

### M4. `avatar_url` accepts arbitrary input
`apps/api/routers/users.py:93-94` (`PATCH /users/{id}`) writes
`body.avatar_url` to the DB with no validation. With PR #93's
`UserResponse`/`AuthorInfo` field_validators presigning whatever is in
`avatar_url`, this becomes an IDOR for any S3 key. **Fix:** validate the value
either starts with `avatars/{user_id}/` (an S3 key) or is rejected.

### M5. Comment-attachment upload uses internal S3 endpoint + unsafe filename
`apps/api/routers/comments.py:397-410` calls `s3 = s3_service.get_s3_client()`
then `s3.generate_presigned_url("put_object", ...)`. The internal client uses
`S3_ENDPOINT` (`http://localhost:9000` on MinIO deployments) — unreachable
from the browser, so the presigned URL the client receives points at the
user's own machine. It also leaks the internal endpoint to every API caller.
Should use `s3_service.generate_presigned_put_url()` (the helper the avatar and
branding fixes already introduced). Also: `body.file_name` is interpolated
raw into the S3 key (`f"comment-attachments/{comment_id}/{uuid}/{file_name}"`)
— S3 flattens `..` so no traversal, but control chars / `?` / `#` break keys
and presigned URLs. **Fix:** use the helper + sanitize `file_name` to
`[^A-Za-z0-9._-]` → `_`.

### M6. Comment-attachment GET URLs serve inline (stored-XSS surface)
`apps/api/routers/comments.py:58-66` `_build_attachment_response` generates a
presigned GET URL with no `download_filename`. An attacker who uploads an
attachment with `body.content_type = "text/html"` gets a URL that the browser
renders as HTML. The content runs in the S3 origin (different from the app
origin so it can't read app localStorage directly) but enables phishing and
abuses the bucket as a hosting service. **Fix:** always pass
`download_filename=attachment.original_filename` so S3 returns
`Content-Disposition: attachment`.

### M7. S3 bucket CORS config does not strip path from `frontend_url`
`apps/api/services/s3_service.py:107` uses
`AllowedOrigins: [settings.frontend_url, ...]` verbatim. Browser `Origin`
headers never include a path, so any deployment with
`FRONTEND_URL=https://host/freeframe` produces CORS-rejected uploads. Already
fixed in `main.py` (upstream uses `urlparse`) and on the live instance —
`ensure_bucket_exists` needs the same treatment. **Fix:** mirror the
`urlparse` strip used in `main.py`.

### M8. `update_preferences` accepts arbitrary dict
`apps/api/routers/auth.py:239-254` takes `body: dict` — no Pydantic schema, no
size limit. Users can store anything (giant JSON, nested objects). If any
preference value is rendered back without escaping, it's a stored-XSS surface.
**Fix:** introduce a `PreferencesUpdate` schema (known keys only, primitive
values).

### M9. Reusable refresh tokens + no rate limit on `/auth/refresh`
`apps/api/routers/auth.py:219-231` issues new access + refresh tokens but does
**not** invalidate the old refresh token. A stolen refresh token remains valid
for 7 days. The endpoint also has no `rate_limit` dep
(`/auth/send-magic-code` and `/auth/verify-magic-code` do). **Fix:** add a
modest rate limit + (recommendation) rotate refresh tokens (one-time-use) in
a follow-up.

### M10. Tokens in `localStorage` + non-HttpOnly/non-Secure cookies
`apps/web/lib/auth.ts:16-23` stores JWTs in `localStorage` and sets plain
`SameSite=Lax` cookies (no `Secure`, no `HttpOnly`). Any XSS = full token
theft, and there is no CSP either. The HttpOnly-cookie migration is a sizable
refactor (requires API Set-Cookie handling) and is **documented as a
recommendation**, not fixed here. Note: the middleware reads cookies via
`request.cookies`, so dropping localStorage for HttpOnly cookies is the
correct end-state.

---

## 🟢 LOW / defense-in-depth

### L1. LIKE patterns not escaped
`apps/api/routers/users.py:43-46` (`search_users`) and
`apps/api/routers/me.py:100,124` (`list_my_assets`, `search_my_folders`) use
`ilike(f"%{q}%")` without escaping `%` / `_`. Not SQL injection
(parameterized) but wildcard-spoofing. Use the existing `_escape_like` helper
already in `routers/share.py:51`.

### L2. S3 bucket CORS too permissive
`s3_service.py:105-106` sets `AllowedHeaders: ["*"]` and `AllowedMethods`
including `DELETE`. No presigned-DELETE flow exists. Tighten to
`["Content-Type", "Content-MD5", "x-amz-content-sha256", "x-amz-date"]` and
drop `DELETE`.

### L3. Hardcoded `/login` redirect ignores basePath
`apps/web/lib/auth.ts:32` does `window.location.href = '/login'` — on the live
`basePath: '/freeframe'` deployment this hits the nginx catch-all 302 and
causes a "secure connection" error (per STATE.md the live instance already
patches this). **Fix upstream:** make it `'/login'` resolved through
`basePath`. (Minimal: prepend `process.env.NEXT_PUBLIC_BASE_PATH || ''`.)

### L4. No nginx security headers
Live `/etc/nginx/sites-available/freeframe` sets no
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Strict-Transport-Security`, `Referrer-Policy: no-referrer`, or CSP. Instance
config fix (not upstream code).

### L5. `X-Forwarded-Proto` set from `$scheme` (http) on the live nginx
FastAPI believes it's serving HTTP — affects absolute redirect URLs and
secure-cookie flags. Fix: `proxy_set_header X-Forwarded-Proto https;` on
each `location` (or `map`-based).

### L6. Systemd services run as `root`, `.env*` mode `644`, MinIO console on `*:9001`
Live unit files (`freeframe-api`, `freeframe-web`, `freeframe-celery-worker`,
`minio`) all run as `User=root`; the Incus lxc override disables every
hardening knob (`NoNewPrivileges=no`, `ProtectSystem=no`, etc.).
`.env.freeframe`, `.env`, `.db_creds` are world-readable (644) inside the
container. MinIO's console binds `*:9001` (only reachable inside the bridge,
but unnecessary). Defense-in-depth only — the container is "`Privileged: yes`
" per STATE.md, so root-in-container is the de-facto trust boundary. Fix on
the instance later.

### L7. Missing `/etc/rubenxyz/SYSTEM.md`
`AGENTS.md` → "First Action on Any Remote" reads `/etc/rubenxyz/SYSTEM.md`,
but the file does not exist on the freeframe container. Process gap, not a
vuln.

---

## Dependency audit
`apps/web/package.json` pins `next: 14.2.35` (latest 14.2.x patch as of the
audit), `hls.js: ^1.6.16`, `fabric: ^7.2.0`. No known critical CVE chain
identified against these versions at audit time. Recommend running
`pnpm audit` in CI and pinning patch releases. `pnpm-lock.yaml` is committed
— keep it updated.

`apps/api/requirements.txt` was not runtime-fingerprinted; recommend
`pip-audit` for the API deps as well.

---

## Fix plan (this PR — upstream code only)
Per-finding commits on `feature/security-fixes` (branched from `upstream/main`):

1. C1 — drop `invite_token` from `UserResponse`; add admin-scoped serializer.
2. C2 — comment endpoints use `validate_share_link_with_session`.
3. H1 — send-magic-code no longer creates accounts or sends to unknown emails.
4. H3 — `POST /share/{token}/verify` for password; GET drops the param;
   frontend follow-up.
5. M1 — password strength `min_length=8`.
6. M3 — branding `logo_*_key` prefix validation.
7. M4 — `avatar_url` prefix validation.
8. M5 — attachment presign via `generate_presigned_put_url` + sanitize name.
9. M6 — attachment GETs use `download_filename`.
10. M2 — drop public-read bucket policy on `processed/*`.
11. M7 — strip path when setting bucket CORS origin in `ensure_bucket_exists`.
12. L2 — tighten bucket CORS headers/methods.
13. M8 — `update_preferences` Pydantic schema.
14. L1 — escape LIKE patterns in `users`/`me` routers.
15. M9 — rate-limit `/auth/refresh`.
16. L3 — basePath-aware `/login` redirect on the frontend.
17. H2 — startup warning when docs are enabled on a non-localhost frontend_url.

## Documented as recommendations (not fixed this PR)
- M10 — JWT in HttpOnly-only cookies (large refactor).
- Refresh-token rotation (one-time-use).
- L4/L5/L6 — instance-side hardening (nginx headers, X-Forwarded-Proto,
  systemd User=, file perms) — applied separately to the live instance.