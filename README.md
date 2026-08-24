This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Running Internship Pilot locally from VS Code

Internship Pilot runs entirely on your machine (Next.js website + scheduler + AI
scoring + one browser/application worker). Use the single canonical command —
it starts each service exactly once, verifies migrations, waits for health, and
opens the browser. It never starts a second copy on top of a healthy one and
never kills unrelated processes.

### Local architecture — three independent processes

`npm run local` supervises three sibling Node processes:

| Process | Entry point | What it does |
| --- | --- | --- |
| Website | `next dev` / `next start` | The Next.js app and its API routes |
| Scheduler worker | `scripts/scheduler-worker.ts` | Radar discovery, verification, Gmail tracking, ATS scoring |
| Application worker | `scripts/application-worker.ts` | The browser/autofill worker |

The scheduler is **not** started by the web process. It used to run from
`src/instrumentation.ts`, which pulled `@/lib/db` → `@prisma/adapter-pg` → `pg`
→ `pgpass` into Next's bundle; on Windows Webpack that made the build fail to
resolve the Node built-ins `fs` and `path`, and the whole website stopped
compiling. `src/lib/runtime/instrumentationBoundary.test.ts` now fails if
anything reaches back across that line.

Because the processes are independent, a crash in the scheduler or the
application worker leaves the website serving. You lose background discovery or
autofill until it is restarted; all queue state is durable in PostgreSQL, so a
restart resumes rather than loses work.

### FIRST-TIME SETUP

Internship Pilot runs on PostgreSQL. `npx prisma dev` starts one locally with
no Docker and no install, and prints a connection string.

```
npm.cmd install
npx prisma dev                 # leave running; copy the URL it prints
                               # into .env as DATABASE_URL
npm.cmd run db:migrate         # create the schema
npm.cmd run local
```

Coming from the old SQLite build? `prisma/README.md` explains the move and
`npm run db:import-sqlite` copies an existing `dev.db` across. Nothing is
deleted — `dev.db` is opened read-only.

Everything else is unchanged: the local Internship Agent, Ollama, and Typst
still run on this machine and are still where the AI and the tailored documents
come from.

### NORMAL DAILY STARTUP

**Option 1 — VS Code task:**
`Terminal → Run Task → Internship Pilot: Start`

**Option 2 — Desktop launcher:**
Double-click `Start Internship Pilot.cmd`

**Option 3 — Terminal:**
```
npm.cmd run local
```

### STOPPING

```
npm.cmd run local:stop
```

(or double-click `Stop Internship Pilot.cmd`). This stops only the processes
this repository started — recorded in `.internship-pilot/local.json` — and never
touches unrelated Node apps.

### STATUS

```
npm.cmd run local:status
```

Reports the website/scheduler/scoring/application-worker status and PIDs, the
browser + extension readiness, the active database path, and the localhost URL.

### Important

Do **not** run another copy of this project at the same time from Antigravity
(or any other tool). Two servers cannot both own port 3000, and the Chrome
extension is configured to talk to `http://localhost:3000`. `npm run local`
detects an already-healthy server and simply reopens the browser instead of
starting a duplicate.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploying

The website deploys to Vercel; the Agent and Ollama stay on the user's own
computer, reached through the browser extension. See:

- `PRODUCTION_DEPLOYMENT_AUDIT.md` — what assumed a shared machine, and why.
- `DEPLOYMENT_ENVIRONMENT.md` — every environment variable, where it belongs,
  and whether it is a secret.
- `prisma/README.md` — the SQLite → PostgreSQL move and the data import.
