# Keygen Portal Deployment

## Architecture

Existing production licensing remains owned by the `/root/keygen` Compose
project:

```text
Existing applications -> Keygen API -> Postgres/Redis/worker

Browser -> Caddy reverse proxy -> Keygen Portal -> Keygen API
```

Portal is a static React/Vite frontend. It does not replace Keygen API, does not
own the database, and should remain safe to delete without affecting license
validation, activation, heartbeat, or other application licensing calls.

## Pinned versions

Everything that affects the build or runtime is pinned. Nothing floats, so a
rebuild produces the same Portal, and `docker compose pull` will not silently
upgrade Keygen.

| Component | Pinned to | Where |
|---|---|---|
| Portal source | commit `6e1fca766ba4e9b8322fbf7cfdc7c2134e6cc782` | `/root/keygen-portal/.env` (`KEYGEN_PORTAL_COMMIT`) |
| Portal build image | `node:22.23.3-alpine3.24@sha256:0a7108bf…` | `/root/keygen-portal/Dockerfile` |
| pnpm | `10.25.0` | `/root/keygen-portal/Dockerfile` |
| JS dependencies | upstream `pnpm-lock.yaml` (`--frozen-lockfile`) | pinned commit |
| Portal runtime image | `caddy:2.10.2-alpine@sha256:4c6e91c6…` | `/root/keygen-portal/Dockerfile` |
| Keygen API (web, worker, migrate, setup, console) | `keygen/api:v1.7.2` | `/root/keygen/compose.yaml` |

The Docker image tags include the `@sha256:` digest. If a tag is ever
re-pushed upstream, the build keeps using the exact image recorded here.

Not pinned (outside the Portal, lower risk): `caddy:latest` (reverse proxy) and
`redis` in `/root/keygen/compose.yaml`. `postgres` is pinned to `17.5`.

Check what is running:

```bash
grep '^KEYGEN_PORTAL_COMMIT=' /root/keygen-portal/.env
docker exec keygen-portal cat /srv/version.json
grep -n '^FROM' /root/keygen-portal/Dockerfile
grep -n 'image: keygen' /root/keygen/compose.yaml
```

## Compatibility requirements

- **Keygen API v1.7 or newer.** Portal lists records using cursor pagination
  (`page[cursor]`), which was added in Keygen v1.7. On v1.6 and older, every
  list request returns `400 page number must be a number greater than 0` and
  Portal shows empty pages. Never downgrade Keygen below v1.7 while Portal is in
  use.
- Portal sends `page[cursor]=` (empty) for the first page. Keygen v1.7 accepts
  this. Do not "fix" it by dropping the parameter, because v1.7 rejects
  `page[size]` without a cursor or number.

## Local patches

The Docker build applies every `patches/*.patch` to the pinned Portal commit
with `git apply`. If a patch stops matching (usually after changing
`KEYGEN_PORTAL_COMMIT`), the build fails instead of silently skipping it.

- `null-safe-clipboard-button.patch`: Keygen omits the `key` attribute for
  licenses on `LEGACY_ENCRYPT` policies, because it stores only a hash of the
  key. Unpatched, the licenses page crashes with
  `undefined is not an object (evaluating 'e.length')`. The patch renders a dash
  instead. The license affected today is `08514471-6964-4a39-96d1-4f6dc39cd23f`.
- `null-safe-truncate-key.patch`: the same missing `key` crashes the license
  detail page, which calls `truncateKey()` directly instead of going through
  the clipboard button. The patch makes `truncateKey()` return a dash for a
  missing key.

When updating Portal, check whether upstream has fixed this. If so, delete the
patch file. If the build fails at `git apply`, regenerate the patch against the
new commit.

## Current configuration

```text
Portal hostname: licensing-portal.aeriform.app
Keygen API: licensing.aeriform.app
Keygen API version header: 1.8 (server: keygen/api v1.7.2)
Keygen edition: CE
Keygen mode: singleplayer
Authentication scheme: token
```

## External prerequisites

DNS:

```text
licensing-portal.aeriform.app -> 159.65.44.3
```

The reverse proxy for this hostname lives in `/root/keygen/Caddyfile` and
manages HTTPS automatically.

The Keygen API returns `Access-Control-Allow-Origin: *`. Portal uses token
auth, so it does not rely on browser cookies for API calls.

The `VITE_*` values are compiled into the frontend bundle. Do not place admin
tokens, product tokens, database passwords, Redis passwords, Keygen encryption
keys, or other private credentials in these values.

## Commands

Run from `/root/keygen-portal`:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f portal
```

The reverse proxy is managed by `/root/keygen/compose.yaml` and
`/root/keygen/Caddyfile`.

## Updating Portal

Never automatically pull and redeploy `master`.

1. Record the current commit (for rollback):

   ```bash
   grep '^KEYGEN_PORTAL_COMMIT=' /root/keygen-portal/.env
   ```

2. Find and review the upstream commit:

   ```bash
   git ls-remote https://github.com/keygen-sh/keygen-portal.git refs/heads/master
   ```

   Check the upstream changes for a newer minimum Keygen API version. If it
   needs a newer API, upgrade Keygen first (see below).

3. Set `KEYGEN_PORTAL_COMMIT=<new-reviewed-sha>` in `.env`.

4. Rebuild and redeploy:

   ```bash
   cd /root/keygen-portal
   docker compose build --no-cache portal
   docker compose up -d portal
   docker compose ps
   ```

5. Hard-refresh the browser and run through **Verification** below.

## Updating the build/runtime images

Only needed for security fixes or when a new Portal commit requires a newer
Node version. Pick an exact tag, then get its digest:

```bash
docker pull node:<version>-alpine<alpine-version>
docker image inspect node:<version>-alpine<alpine-version> --format '{{index .RepoDigests 0}}'
```

Update the `FROM` line in the Dockerfile as `node:<tag>@sha256:<digest>`, then
rebuild with `--no-cache`. Do the same for `caddy`.

## Updating Keygen API

This changes the production licensing server and runs database migrations that
cannot easily be undone. Always back up first.

```bash
cd /root/keygen

# 1. Check available versions
curl -s "https://hub.docker.com/v2/repositories/keygen/api/tags?page_size=10&ordering=last_updated" \
  | python3 -c 'import sys,json; [print(t["name"], t["last_updated"][:10]) for t in json.load(sys.stdin)["results"]]'

# 2. Back up the database (-T avoids TTY characters in the dump)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > ~/keygen-backup-$(date +%F).sql
tail -n 3 ~/keygen-backup-$(date +%F).sql   # must say "PostgreSQL database dump complete"

# 3. Change every keygen/api:vX.Y.Z tag in compose.yaml to the new version, then:
docker compose pull web worker migrate
docker compose --profile migrate run --rm migrate
docker compose up -d web worker

# 4. Confirm
curl -s -o /dev/null -w '%{http_code}\n' https://licensing.aeriform.app/v1/ping   # 200
```

Then check that Portal list pages still load (see **Troubleshooting**).

## Rollback

**Portal:** set `KEYGEN_PORTAL_COMMIT` (and the `FROM` lines, if changed) back
to the previous values, then:

```bash
docker compose -f /root/keygen-portal/compose.yaml build --no-cache portal
docker compose -f /root/keygen-portal/compose.yaml up -d portal
```

Portal rollback only changes the disposable frontend image. It needs no
database, Redis, account, or credential changes.

**Keygen API:** after migrations have run, rolling back the image alone may not
work. Restore the database from the backup taken before the upgrade, then set
the previous image tag. Remember that Portal needs Keygen v1.7 or newer.

## Verification

```bash
curl -I https://licensing-portal.aeriform.app
curl -I https://licensing-portal.aeriform.app/667ccb4f-1ebc-4772-9a21-f73d2d81697e/app/licenses
curl -I https://licensing.aeriform.app
```

In a browser, verify:

- Portal loads over HTTPS.
- Refreshing a nested route loads the app instead of a static server 404.
- Login works through Keygen.
- Dashboard, Products, Policies, Licenses, Users, and Machines show data.
- Logout removes the browser token state and revokes the Portal login token when possible.
- Unauthenticated visitors are redirected to the Portal login flow and cannot view account data.
- Existing licensing clients continue to use `licensing.aeriform.app` directly.

## Troubleshooting

The Keygen API log records every Portal request with its status. This shows
Portal requests from the last 10 minutes:

```bash
docker logs --since 10m keygen-web-1 2>&1 | grep 'origin=https://licensing-portal' \
  | grep -oE '^I, \[[^ .]*|path=[^ ]*|status=[0-9]+|query_params=[^ ]*' | paste - - - -
```

For a 4xx/5xx, the log line's `encoded_response=` field is the base64-encoded
error body (`echo <value> | base64 -d`).

| Symptom | Cause | Fix |
|---|---|---|
| Pages empty; list requests return 400 `page number must be a number greater than 0` | Keygen API older than v1.7 | Upgrade Keygen to v1.7 or newer |
| Pages empty; 400 `page must be an object containing a cursor or number` | Portal built with a patch that drops `page[cursor]` | Remove that patch and rebuild |
| Page shows "Something went wrong!" but API requests return 200 | Portal can't handle a field missing from the API response | Open the browser console, find the field, and add a patch in `patches/` |
| Changes not visible after rebuild | Browser cached the old bundle | Hard-refresh (Cmd+Shift+R) or log out and back in |
| Dashboard charts empty; `/-/accounts/.../analytics/*` return 404 | Keygen API too old for Portal analytics | Upgrade Keygen |

## History

- **2026-10-07:** Portal showed empty pages. Root cause: Keygen API v1.6.0 had
  no cursor pagination. Took a database backup (`~/keygen-backup-2026-10-07.sql`)
  and upgraded Keygen to v1.7.2. Removed the obsolete `fix-empty-page-cursor.sh`
  patch. Added `null-safe-clipboard-button.patch` for the legacy-encrypted
  license crash. Pinned `keygen/api:v1.7.2` (previous compose file:
  `/root/keygen/compose.yaml.bak-20261007`).
- **2026-10-08:** Pinned the Portal build and runtime images to exact versions
  and digests.
- **2026-10-09:** Added `null-safe-truncate-key.patch`. The license detail page
  for `08514471-…` still crashed after the clipboard patch.

## Keymana replacement notes

| Function | Keygen Portal | Keymana | Notes |
|---|---|---|---|
| Products | Supported | Existing tool | Portal has product list/detail/create/update/remove routes. |
| Policies | Supported | Existing tool | Portal has policy list/detail/create/update/remove routes. |
| Licenses | Supported | Existing tool | Portal supports license CRUD plus suspend/reinstate/renew/check-out/check-in/reset usage and relationship changes. |
| Users | Supported | Existing tool | Portal supports users, password/ban operations, groups, and product relationships. |
| Machines | Supported | Existing tool | Portal supports machine list/detail/create/update/remove and heartbeat reset. |
| Webhooks | Supported | Existing tool | Portal has webhook endpoint and webhook event views, including retry/remove for events. |
| Account settings | Partially supported | Existing tool | Portal has general, developer, security, permissions, team, billing, and token/account surfaces; confirm against the exact Keymana workflows you rely on. |

Based on the pinned source, Portal appears likely to cover the core Keymana
administrative workflows listed above, but keep Keymana available until you have
manually verified any account-setting and webhook workflows you use frequently.


## Promotional workflow deployment — 2026-10-09

The portal is now pinned to local feature commit `aace98ec4c020174234ecb5a955ec2b21048e2ae`. The `promo` service provides the administrator-checked Keygen transport and SMTP delivery on the private Docker network. Its environment is `/root/keygen-portal/.promo.env` (mode 0600), excluded from Git and Docker build contexts. Credentials were copied from the legacy reference only after explicit owner approval; they were not printed or committed.

GitHub publishing was unavailable because this session had no GitHub credentials. The local wrapper therefore builds from `portal.bundle` rather than cloning GitHub. The bundle contains the same committed feature branch and no reference files. To update it, run `git -C /root/keygen-portal bundle create /root/keygen-portal/portal.bundle feature/promo-license-workflow`, then set `KEYGEN_PORTAL_COMMIT` to the branch's full SHA. Keep the bundle locally and excluded from source control. Once the branch is pushed, the wrapper can return to cloning `https://github.com/apowell656/keygen-portal.git` instead.

Build both services with `docker compose build portal promo` and recreate them with `docker compose up -d portal promo`. Existing null-safe rendering patches remain applied during the portal build. SMTP delivery requires STARTTLS and is limited to the approved template and the promotional license owner. Email markers persist in the private `promo-mail-state` volume.

Deployment verification succeeded: both services are running, the portal health check passes, the public version endpoint reports `aace98ec`, and unauthenticated email requests receive HTTP 401. SMTP STARTTLS authentication succeeded without sending a message. The feature branch is committed locally but has not been pushed because GitHub authentication is unavailable in this session.

Latest promotional UI/email release: `fbd72ba0a731c67c9ab63d98afef9a3f8ca37101`. Adds dialog padding and an optional marketing product name persisted in license metadata; removes pricing from HTML and plain text. Both containers were rebuilt and deployed, public version `fbd72ba0` verified, and 29 mocked tests pass.

Environment configuration: retain the portal's `.env` for public build settings. SMTP runtime changes belong in the private `.promo.env` (mode 0600); apply them with `docker compose up -d --force-recreate promo`. Do not swap in `references/legacy.env`; its SMTP values have already been copied with owner approval. No image rebuild is needed for SMTP environment changes.

Manual test diagnosis: an assigned promotional license using `LEGACY_ENCRYPT` loses its creation-time raw key on retrieval. The email endpoint's fresh GET therefore has no `attributes.key` and returns “Assigned promotional license required” before SMTP. Ownership and promotional metadata were confirmed valid. The fix in `a398083cc27b3293a3a60cae12c38c42d15d223d` verifies creation-time keys against the existing license before email delivery. Use **Retry Promo Email** with the existing license ID and original saved legacy key; do not create another license merely to retry email. Keys lost after refreshing cannot be recovered from Keygen’s stored hash.

Legacy-key email fix deployed: `a398083cc27b3293a3a60cae12c38c42d15d223d`. Both images built and containers recreated; portal health and public version `a398083c` verified. Unauthenticated email requests still return HTTP 401. Type checking, targeted lint and all 35 mocked regression tests pass. No live license was created and no email was sent during verification.

## GitHub merge and deployment source — 2026-10-09

SSH authentication for `apowell656` now works. The source checkout’s origin uses `git@github.com:apowell656/keygen-portal.git`; upstream remains unchanged. The fork’s default branch is `master`, not `main`. Promotional licensing was merged without conflicts as `70353643940142da3bd8690efc8aeb9e550cac74`, and both `master` and `feature/promo-license-workflow` were pushed. No co-author trailers were added. All 35 mocked tests, TypeScript checks and targeted lint passed on the merged branch.

The deployment Dockerfile now clones `https://github.com/apowell656/keygen-portal.git` directly and checks out the pinned `KEYGEN_PORTAL_COMMIT`. The previous local bundle is retained as an excluded fallback and is no longer used for builds. Private runtime configuration and reference files remain outside source control.

Direct GitHub build and deployment succeeded. The public version endpoint reports `70353643`, the portal is healthy, and the promotional service remains running with its private configuration and delivery-state volume.

## Consolidated workspace — 2026-10-09

`/root/keygen-portal` now contains the Git checkout and deployment configuration. The sibling source directory has been removed after moving all source files and Git history here. Both Compose build contexts use `.`. The root README is the project README; this file preserves the deployment guide and history. Private `.env`, `.promo.env`, references and the fallback bundle remain excluded from Git and Docker contexts. The existing Compose project name, containers, network and mail-state volume remain the same.
