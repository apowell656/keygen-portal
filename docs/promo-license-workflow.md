# Promotional licenses

The Aeriform addition lives in the existing Licenses section. Admins can select an existing product and associated policy, reuse a customer by email or create a passwordless customer, create a promotional license, assign ownership, and optionally send the existing Aeriform email. It introduces no customer database, invitations, billing, new navigation, or license detail screens.

## Architecture assessment

The checked-out origin is https://github.com/apowell656/keygen-portal; upstream remains https://github.com/keygen-sh/keygen-portal. The feature branch is `feature/promo-license-workflow`. The initial source had no promo feature, an untracked pnpm cache, and installed dependencies. No tracked development work was replaced.

The app is a Vite SPA. Its Wrangler configuration serves static assets with no handler; the existing Aeriform Docker deployment serves static assets through Caddy. Neither originally provided a trusted email runtime. The wrapper Dockerfile originally cloned upstream, so unpatched fork changes would not ship. It now clones the Aeriform fork; select a fork commit containing this feature before building the wrapper.

The smallest secure integration adds a small Node HTTP service behind Caddy for two fixed paths. It uses the Portal's existing user, policy, license and ownership API utilities and request envelopes through an optional protected transport in `Client.request`. Other application requests retain their existing transport. Product/policy selection uses the existing environment-scoped queries. The server calls Keygen `/me` with the authenticated caller's token and requires the `admin` role before forwarding any promo operation. Keygen independently enforces that token's permissions, account and environment. No legacy service admin token is required or copied into the frontend. The UI also requires creation, ownership, user, product and policy permissions.

`/api/promo/keygen` permits only user lookup/creation, policy reads, promotional license creation and ownership assignment in the configured account. It validates recipient ownership and the policy's product. It is not a general API proxy. `/api/promo/email` accepts a license ID only, loads the license, owner, policy and product from Keygen, and derives recipient, key, subject and email contents from those records. Callers cannot supply an email body or arbitrary recipient. Origin checks, POST-only handling, bounded bodies, server-side admin checks and send limits protect the endpoints. Tokens are forwarded only to the fixed HTTPS Keygen origin. No credentials or license keys are logged.

## Configuration and deployment

The original files in `/root/keygen-portal/references` remain outside the checkout. `references/` is ignored by Git, local `.git/info/exclude`, and Docker. Only the HTML template was copied to `src/promo/email.html` and given the requested promotional copy corrections. Never copy `legacy.env` into source or public assets.

Keep existing public `VITE_KEYGEN_*` settings. Configure the private service using placeholders in `server/.env.example`. Keygen base origin, account, version and public portal origin must match the frontend. `PORTAL_ORIGIN` is the exact HTTPS browser origin, without a trailing slash. SMTP uses port 587 with mandatory STARTTLS and normal certificate verification. `FROM_EMAIL` and `SUPPORT_EMAIL` are approved server-side sender/support addresses. Missing SMTP settings still permit no-email provisioning; email attempts fail explicitly. `KEYGEN_ADMIN_TOKEN` and product authentication tokens are unnecessary.

The existing wrapper at `/root/keygen-portal` now includes the `promo` service in Compose, routes `/api/promo/*` to it, and builds the fork. Copy `server/.env.example` to that wrapper's `.promo.env`, supply private settings through your secret manager or that untracked restricted file, and set `KEYGEN_PORTAL_COMMIT` to a commit in the fork containing this integration. Keep the source checkout at the sibling `../keygen-portal-src`, or adjust the service build context. Run `docker compose build` then deploy using your normal approval/change process. No deployed services were modified during development.

For other hosting, build `server/Dockerfile` using the source repository as context and proxy the two paths on the portal's same HTTPS origin. Persist `/data` in a writable private volume. Keep the service on a private network and run one instance: its process locks and rate limits assume a single instance. Do not expose it as a public general-purpose endpoint. Development can use a same-origin reverse proxy to Vite and the service.

Wrangler's current static asset deployment alone cannot run this SMTP service. To use that deployment, configure an equivalent authenticated endpoint behind the same origin, or provide a reviewed Worker-compatible email transport. Do not deploy just the static frontend and expect SMTP to work. Session-cookie and demo modes are excluded from the promo action; the current deployment uses token authentication.

## Workflow and recovery

1. Open Licenses → Create Promo License. Select a product and a policy belonging to it.
2. Supply first name, email, reason, optional last name, promo tag and custom license name. Suggested reasons allow free text. The default name is `{Product Name} Promo ({Customer Email})`.
3. Review the irreversible-operation summary and email preview. The key is explicitly a preview placeholder until creation. Uncheck Send email to provision without delivery.
4. Confirm creation. Existing customers are looked up by their encoded email identifier, as documented by Keygen: https://keygen.sh/docs/api/users/. Only a NOT_FOUND result permits creation; concurrent EMAIL_TAKEN results trigger another lookup. Password and invitation setup is outside this workflow.
5. The license stores the Python reference's metadata fields, using the product code (or ID) for `app`. Ownership uses the existing PUT owner relationship: https://keygen.sh/docs/api/licenses/.
6. The result displays customer, product, policy, license name, ID, key, ownership and email status, with links through existing resource navigation. Normal license/user views refresh.

A successful customer or license remains preserved on later failure. Form edits are frozen once a customer is resolved; retry resumes using recorded IDs. Ownership retries use the same license. SMTP rejection permits email retry without any creation. Closing the dialog preserves its in-memory progress while the Licenses page remains mounted; navigation/reload clears that form state. Before re-entering after navigation, inspect existing Keygen records. Interrupted license creation is marked uncertain and blocked from automatic retry because it may have succeeded.

SMTP acceptance and application persistence cannot be one atomic operation. The service records a hashed license/account/environment delivery marker before sending. Successful sends are deduplicated across restarts. Definite SMTP rejection clears the marker for retry. Timeouts, connection loss, crashes and persistence failure retain a pending marker to prevent duplicate mail. An administrator must verify SMTP provider delivery first, then remove the corresponding pending record in the private volume if delivery definitely did not happen. Record names are SHA-256 of `account:environment-or-global:license-id`; records contain only status and timestamp, no key or recipient. The volume is operational state, not a new customer database. Do not delete sent markers merely to resend.

## Validation and maintenance

Use the existing Vitest framework (`pnpm test`), TypeScript (`pnpm build` includes it), `pnpm lint:check`, and production build. Tests mock Keygen and SMTP and never create real licenses or send real emails. The separate SMTP package has its own lockfile and `npm ci --omit=dev` in its container. Keep the portal dependency graph unchanged.

Custom files are `src/promo/*`, `src/components/licenses/promo-dialog.tsx`, `server/*`, this documentation and Docker exclusions. Small upstream integration points are the license list action, optional promo flags on existing API utilities, and Client's protected transport. Preserve these additions when merging upstream; maintain the existing API shapes rather than adding a parallel data model.

## Verification performed

Development verification passed with placeholder public configuration in disposable Node 22 containers:

- Route generation and TypeScript project build (`tsr generate`, `tsc -b`).
- Full existing ESLint check (`eslint ./src`).
- Full Vitest run: 27 tests across workflow, UI access and server endpoint tests.
- Vite production build. The existing large-chunk warning remains; it was also present in the baseline build.
- SMTP service Docker build and dependency audit (zero reported vulnerabilities).
- Offline adapter check confirmed multipart/alternative with HTML and plain text.
- Offline service startup confirmed the private writable state directory and rejected unauthenticated/wrong-origin HTTP calls.
- Caddy configuration validation and Compose validation with placeholder environment files.
- Secret-value scan confirmed that the legacy admin token and SMTP password are absent from source, documentation, service files and production assets.

Node/pnpm were unavailable on the session host, so equivalent project binaries were run inside an isolated Node container. The frontend lockfile remains unchanged. No real Keygen mutations, SMTP deliveries, production deployment, commits or remote pushes were performed. Before deployment, review and commit/push the feature branch, pin the wrapper to that fork commit, configure the private service, and verify a controlled staging workflow.
