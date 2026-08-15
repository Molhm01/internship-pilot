# Deployment environment

Every environment variable Internship Pilot reads, where it belongs, and
whether it is a secret.

The application runs in two places at once and the split is the whole point:

| Piece | Where it runs | Reaches |
| --- | --- | --- |
| Next.js web app | Vercel (or localhost) | Postgres, Blob storage, public APIs |
| Browser extension | The user's browser | The website over HTTPS, and the page being filled |
| Internship Agent | The user's computer, `127.0.0.1:4317` | Local documents, local browser |
| Ollama | The user's computer, `localhost:11434` | Nothing outside that machine |

A variable in the "Local Agent only" or "Local development only" row has no
useful effect when set on Vercel. Setting them there is harmless but
misleading — the deployed server detects that it is not the user's machine and
declines the loopback call rather than attempting it.

## Classification

| Variable | Where it belongs | Required? | Purpose | Secret? |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Vercel production **and** local development | **Yes** | PostgreSQL connection string. Vercel injects it when a Prisma Postgres store is connected; `npx prisma dev` prints one locally. | **Yes** |
| `BETTER_AUTH_SECRET` | Vercel production **and** local development | **Yes** | Signs session cookies. Generate one per environment; rotating it signs everybody out. | **Yes** |
| `BETTER_AUTH_URL` | Vercel production | **Yes** in production | Canonical origin for authentication and the OAuth callback. Falls back to `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL`, then `http://localhost:3000`. Set explicitly: the per-deployment `VERCEL_URL` is the wrong redirect target for a stable Google client. | No |
| `GOOGLE_CLIENT_ID` | Vercel production, optional | No | Google OAuth client. Without it *and* the secret, "Continue with Google" is not shown. | No |
| `GOOGLE_CLIENT_SECRET` | Vercel production, optional | No | The other half of the Google OAuth client. | **Yes** |
| `NEXT_PUBLIC_APP_URL` | Vercel production | **Yes** in production | Canonical public origin. Drives `metadataBase` and the default Gmail OAuth callback. Falls back to `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`, then to `http://localhost:3000` in development only. | No — deliberately public |
| `BLOB_READ_WRITE_TOKEN` | Vercel production | **Yes** when storage is `vercel-blob` | Vercel Blob store credential. Injected automatically once a Blob store is connected. | **Yes** |
| `DOCUMENT_STORAGE_DRIVER` | Optional, either side | No | `local` or `vercel-blob`. Defaults from the runtime: local installs write to disk, cloud deployments to Blob. | No |
| `INTERNSHIP_PILOT_RUNTIME` | Optional, either side | No | `local` or `cloud`, overriding detection. Only needed for a self-hosted server that genuinely shares a machine with the user's Agent and Ollama. | No |
| `DATABASE_POOL_MAX` | Optional, either side | No | Postgres connections per instance. Default 5. | No |
| `DATABASE_CONNECT_TIMEOUT_MS` | Optional, either side | No | Connection acquisition timeout in ms. Default 15000. | No |
| `OLLAMA_BASE_URL` | Local development only | No | Local model server. Default `http://localhost:11434`. On a cloud runtime a loopback value is recognised as unreachable and reported as **Local AI offline**; a non-loopback value the deployment can actually reach is used normally. | No |
| `OLLAMA_MODEL` | Local development only | No | Chat model name. Default `qwen3.5:9b`. | No |
| `OLLAMA_VISION_MODEL` | Local development only | No | Vision model for the application agent. Defaults to `OLLAMA_MODEL`. | No |
| `AI_MATCH_*` | Local development only | No | AI Match concurrency, timeouts, context and prediction budgets. | No |
| `TYPST_BIN` | Local development only | No | Path to the Typst CLI that compiles tailored PDFs. Typst is a native binary and does not exist on a serverless host, so document generation is local-only. | No |
| `GENERATED_OUTPUT_DIR` | Local development only | No | Where generated PDFs land under the local storage driver. Default `data/generated`. | No |
| `RESUME_STORAGE_DIR` | Local development only | No | Where uploaded résumés land under the local storage driver. Default `data/resumes`. | No |
| `LOCAL_DOCUMENT_STORAGE_ROOT` | Local development only | No | Root that local storage keys resolve inside. Default: the repository. Keys that escape it are refused. | No |
| `GMAIL_CLIENT_ID` | Optional, Vercel + local | No | Google OAuth client id. Without it Gmail tracking stays off and everything else works. | No |
| `GMAIL_CLIENT_SECRET` | Optional, Vercel + local | No | Google OAuth client secret. | **Yes** |
| `GMAIL_REDIRECT_URI` | Optional, Vercel + local | No | Overrides the callback URL. Defaults to `<NEXT_PUBLIC_APP_URL>/api/gmail/auth/callback`. Whatever it resolves to must be registered verbatim in Google Cloud. | No |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Optional, Vercel + local | Required if Gmail is enabled | Encrypts Gmail OAuth tokens at rest. Generate a **different** value per environment. | **Yes** |
| `USAJOBS_API_KEY` | Optional, Vercel + local | No | Higher USAJOBS.gov rate limits and coverage. | **Yes** |
| `USAJOBS_USER_AGENT` | Optional, Vercel + local | No | Email address USAJOBS requires alongside the key. | No |
| `GOOGLE_PLACES_API_KEY` | Optional, Vercel + local | No | Enables automatic Nearby Firms results. | **Yes** |
| `INTERNSHIP_AGENT_BASE_URL` | Local Agent only | No | Loopback address of the Internship Agent. Must be `http://` loopback. Default `http://127.0.0.1:4317`. | No |
| `INTERNSHIP_AGENT_TOKEN` | Local Agent only | No | Shared secret the Agent accepts. Fallback for the token file. | **Yes** |
| `INTERNSHIP_AGENT_TOKEN_FILE` | Local Agent only | No | Preferred: absolute path to the Agent's `local-data/agent-token.txt`, read at request time so a recreated Agent data directory cannot leave this side on a stale secret. | Points at a secret |
| `APPLICATION_WORKER_USER_ID` | Local Agent only | No | Which account the local Playwright worker fills applications for. Needed only when the install has more than one account; the worker refuses to guess. | No |
| `APPLICATION_BROWSER_PROFILE_DIR` | Local development only | No | Persistent Playwright profile for the application worker. | No |
| `APPLICATION_OUTPUT_DIR` | Local development only | No | Where application-run artefacts are written. | No |
| `APPLICATION_WORKER_PORT` | Local development only | No | Health port of the local application worker. | No |
| `INTERNSHIP_PILOT_EXTENSION_DIR` | Local development only | No | Unpacked extension the local worker loads. Default `extension/dist`. | No |
| `BASE_URL` | Test only | No | Target for the `scripts/test-*.ts` HTTP probes. Not read by the application. | No |
| `FORCE_HEADLESS`, `ISOLATED_TEST_MODE`, `TEST_TEMP_ROOT`, `LEGACY_COPY_TEST`, `DOM_FALLBACK_COPY_TEST`, `APPLICATION_WORKER_TEST_ONLY` | Test only | No | Harness switches for the local regression scripts. | No |
| `VERCEL`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | Provided by Vercel | n/a | Read, never set by hand. `VERCEL=1` is how the runtime is detected as cloud. | No |

## What must be set on Vercel

Minimum for a working deployment:

```
DATABASE_URL             (injected by the Prisma Postgres integration)
BLOB_READ_WRITE_TOKEN    (injected by the Blob store integration)
NEXT_PUBLIC_APP_URL      (set by hand, per environment)
BETTER_AUTH_SECRET       (generate one per environment; never reuse)
BETTER_AUTH_URL          (the stable production origin)
```

Add `GMAIL_*`, `USAJOBS_*`, and `GOOGLE_PLACES_API_KEY` only if those features
are wanted, and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google sign-in.

There is no longer a single-user switch. Every private route authenticates the
session and filters by its user id; accounts are the only mode.

Do **not** set `INTERNSHIP_AGENT_TOKEN`, `INTERNSHIP_AGENT_TOKEN_FILE`, or
`TYPST_BIN` on Vercel. They describe software on the user's computer.

## Client-side exposure

Only `NEXT_PUBLIC_`-prefixed values are compiled into the browser bundle, and
exactly one variable carries that prefix: `NEXT_PUBLIC_APP_URL`, which is the
site's own address and public by definition.

Never add a `NEXT_PUBLIC_` prefix to `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`,
`INTERNSHIP_AGENT_TOKEN`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`,
`GMAIL_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `USAJOBS_API_KEY`, or
`GOOGLE_PLACES_API_KEY`. `src/lib/runtime/environmentContract.test.ts` fails
if one of them appears with that prefix or is read from a client module.
