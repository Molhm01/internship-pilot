# Setup Guide — Internship Pilot

This app runs entirely on your own computer. Nothing you do here uploads your resume, your email,
or your application answers anywhere except the official employer sites you choose to apply to.

Everything below is **optional** — the app works without any of it, just with fewer features.
Skip anything you don't need right now and come back later.

## 1. Nothing to set up (works out of the box)

- Job discovery from Intern List (the Company Watchlist side needs the CSV file below to have
  anything to check — see step 2)
- Strict verification (Jobs page only ever shows VERIFIED_OFFICIAL_AT_LAST_CHECK postings)
- Fraud protection (Security Quarantine) and the New Employer Review approval flow
- The persistent scheduler (runs automatically whenever the app is running)
- Resume upload, fact approval, AI Match, document generation
- Fill To Submit application mode (once you connect a resume + Application Profile)

## 2. The employer allowlist (required for Company Watchlist discovery)

This app discovers internships from exactly two sources: **Intern List**, and the official career
pages of employers listed in `data/approved_engineering_employers.csv`. That file needs to exist
for the Company Watchlist side of discovery to do anything — until you add it, only Intern List
discovery is active.

Add a CSV file at `data/approved_engineering_employers.csv` with these exact columns:

```
Employer, Sector, Careers / Jobs URL, Career Domain, EE/CPE Internship Fit,
Verification Status, Verification Basis, Verified / Curated Date,
Recommended Search Terms, Canonical Apply Rule
```

Once it's there, the scheduler picks it up automatically within 30 minutes (or restart the app for
it to sync immediately). Employers you remove from the file later are excluded from future checks
(not deleted — their history stays on the Watchlist page, just inactive).

If Intern List surfaces a job from an employer not yet in your CSV, it's held on the **New Employer
Review** page instead of being auto-ingested — approve its real official domain there once to
start checking it.

## 3. Application Profile (recommended — do this next)

Open **Documents** in the left nav and fill in:
- Your name, email, phone, school, LinkedIn/GitHub/website
- "Application-form answers" — work authorization, visa sponsorship, security clearance, and any
  EEO/demographic answers you're comfortable pre-filling. **Leave anything blank and the
  Application Agent will always stop and ask you directly instead of guessing** — nothing here is
  ever invented.

## 4. USAJOBS — currently disabled by design

The strict discovery boundary limits internship discovery to exactly two sources: Intern List and
your CSV allowlist. USAJOBS was intentionally removed from the automatic scheduler for this reason
— there's nothing to set up here, and setting a USAJOBS API key would have no effect on discovery.
The adapter code still exists in case a future version re-enables it as a CSV-driven source.

## 5. Google Places API key (optional)

Unlocks automatic discovery on the **Nearby Firms** page (search radius around your chosen city).
1. Go to https://console.cloud.google.com/ and create a project (or use an existing one)
2. Enable the **Places API**
3. Create an API key (APIs & Services → Credentials → Create Credentials → API Key)
4. Open `.env` and set:
   ```
   GOOGLE_PLACES_API_KEY="your key"
   ```
5. Restart the app

Note: Google Places has a free monthly usage tier; heavy use may incur cost on your own Google
account. The app only ever calls the official Text Search / Place Details / Geocoding APIs — never
scrapes Google Maps.

## 6. Gmail Application Tracking (optional, requires your own Google Cloud project)

This lets the app watch your Gmail (read-only) for application confirmations, interview requests,
assessments, and rejections, and update the Tracker automatically. **It can never send, delete,
archive, or modify anything in your mailbox**, and your Google password is never seen or stored by
this app.

1. Go to https://console.cloud.google.com/ and create a project (or reuse the one from step 4)
2. Enable the **Gmail API** (APIs & Services → Library → search "Gmail API" → Enable)
3. Configure the OAuth consent screen (APIs & Services → OAuth consent screen):
   - User type: **External** is fine for personal use
   - Add your own Google account as a **test user** (this keeps the app in "Testing" mode, which
     is all you need — you don't need to publish it or get it verified by Google)
   - Scope: add `https://www.googleapis.com/auth/gmail.readonly`
4. Create credentials (APIs & Services → Credentials → Create Credentials → OAuth client ID):
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/api/gmail/auth/callback`
5. Copy the **Client ID** and **Client Secret**, open `.env`, and set:
   ```
   GMAIL_CLIENT_ID="your client id"
   GMAIL_CLIENT_SECRET="your client secret"
   ```
6. Restart the app, open **Documents**, and click **Connect Gmail** under "Gmail Application
   Tracking." You'll be sent to Google's real sign-in/consent page — sign in with the same account
   you added as a test user.
7. Gmail is checked automatically every 5 minutes from then on. You can also click "Check now" any
   time, or "Disconnect" to revoke access (also revocable any time at
   https://myaccount.google.com/permissions).

**Assessment Inbox**: when an email mentions a coding/skills assessment, it shows up on the
**Assessment Inbox** page with whatever the email actually stated (provider, deadline, duration,
link) — never invented. The app will **never take, solve, or submit an assessment for you**; it
only detects and reminds you.

## 7. Windows auto-launch at startup (optional)

```
npm run startup:install
```
Installs a Windows Startup shortcut so the app (and its scheduler) launches automatically when you
log in. To undo:
```
npm run startup:uninstall
```

## 8. Browser login for the Application Agent (only needed for ATS platforms requiring an account)

Greenhouse, Lever, and Ashby's public "apply as a guest" forms don't require creating an account,
so nothing extra is needed for those. Workday and a few others typically do require a candidate
account — that's **not yet enabled for autofill** in this version (see below), so there's nothing
to set up for it right now.

## 9. Enabling Fill To Submit mode

On the **Documents** page, under "Application Agent," set Mode to **Fill To Submit**. From then on, the
**Apply with Application Agent** button on a job's page will open the official application page,
fill in every field it has a confident, grounded answer for, and stop — it never clicks Submit in
this mode. Review the filled form yourself and submit it manually.

The agent always stops and asks you (never guesses) when it hits:
- A CAPTCHA
- A login/account requirement
- A hiring assessment
- A citizenship/sponsorship/security-clearance question with no saved answer
- An EEO/demographic question with no saved preference
- A free-text essay question with nothing to draw from
- A dropdown/checkbox it can't confidently map to your data
- Terms/certifications requiring your explicit confirmation

## 10. Enabling Auto-Submit (Allowlist) mode

**Only turn this on once you've supervised Fill To Submit mode successfully on a few real jobs and
trust the results.** On the Documents page, set Mode to **Auto-Submit (Allowlist)**, set a score
threshold (default 75), and list the exact company names you're comfortable letting it submit to
automatically. Any job whose company isn't on that list, or whose match score is below your
threshold, still falls back to Fill To Submit automatically — nothing outside your allowlist is ever
auto-submitted.

Supported application-form autofill today: **Greenhouse, Lever, Ashby, Workday, iCIMS,
SmartRecruiters, SuccessFactors, and Taleo**, all tested against local mock forms shaped like each
platform's typical flow (never a real employer site during development — see
AUTOFILL_READINESS_REPORT.md for exactly what was tested). A real employer's live instance that
needs an account/login first will stop and ask you rather than silently failing.

## What's already safe by default

- Application mode defaults to **Fill To Submit** (it fills supported fields and never clicks Submit)
- Auto-Submit's allowlist is empty by default — nothing is submitted anywhere until you explicitly
  add a company
- The Jobs page only ever shows postings independently verified as VERIFIED_OFFICIAL_AT_LAST_CHECK
- Discovery is limited to Intern List and your CSV allowlist — nothing else is ever crawled for
  internships
- New employers found via Intern List sit in New Employer Review until you approve their domain
- Postings flagged by fraud protection go to Security Quarantine — never autofilled or uploaded to
- Gmail access is read-only and only activates once you explicitly connect it

## Reports

- `SOURCE_SECURITY_REPORT.md` — PASS/FAIL for every discovery/verification/fraud-protection
  requirement, with the specific test behind each one
- `AUTOFILL_READINESS_REPORT.md` — same, for the Candidate Profile, document tailoring, and
  Application Agent
