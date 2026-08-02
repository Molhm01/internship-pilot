This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Running Internship Pilot locally from VS Code

Internship Pilot runs entirely on your machine (Next.js website + scheduler + AI
scoring + one browser/application worker). Use the single canonical command —
it starts each service exactly once, verifies migrations, waits for health, and
opens the browser. It never starts a second copy on top of a healthy one and
never kills unrelated processes.

### FIRST-TIME SETUP

```
npm.cmd install
npm.cmd run local
```

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

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
