# Job Freshness & Sort Audit

Scope: why the Internship Pilot **Jobs** page shows jobs posted days/weeks/months
ago above internships the InternList "Engineering and Development" feed shows as
posted minutes ago, and every date field involved.

Audit performed against `dev.db` (533 Job rows) on 2026-08-01.

---

## 1. Every job date field that exists today

| Field (schema name) | Where written | Meaning | Populated? |
| --- | --- | --- | --- |
| `Job.postingDate` | `src/lib/sync/ingest.ts:277` (create only), `POST /api/jobs`, `PATCH /api/jobs/[id]` | The source's posting timestamp. **This is the closest thing to `sourcePostedAt` that existed.** | 533/533 non-null |
| `Job.createdAt` | Prisma `@default(now())` | Local database row-insert time. | always |
| `Job.updatedAt` | Prisma `@updatedAt` | Local row-write time; changes on every verification / scoring / destination write. | always |
| `Job.firstSeenAt` | `ingest.ts:287` (create only) | First time this app saw the posting. | 530/533 |
| `Job.lastSeenAt` | `ingest.ts:248` (every rediscovery) | Last sync that still listed the posting. | 530/533 |
| `Job.lastVerifiedAt` | verification pipeline | = "verifiedAt". When the destination check last ran. | partial |
| `Job.resolvedAt` | official-destination resolver | When the official URL was resolved. | partial |
| `Job.jobDescriptionCapturedAt` | description capture | When the JD text was captured. | partial |
| `Job.scoringQueuedAt` / `scoringStartedAt` / `scoringFinishedAt` / `scoringHeartbeatAt` | AI Match queue | = "scoredAt" family. | partial |
| `SyncLog.startedAt` / `finishedAt` | `src/lib/sync/discover.ts` | Per-InternList-sync timing. **Not linked to any Job row.** | always |
| `AtsSyncRun.startedAt` / `finishedAt` | `src/lib/sync/atsIngest.ts` | Per-ATS-run timing. **Not linked to any Job row.** | always |

### Equivalent-name check (fields the brief asked about)

| Requested name | Status before this change |
| --- | --- |
| `sourcePostedAt` | **did not exist** — nearest equivalent was `postingDate` |
| `postedAt` | exists only as an in-memory field on `RawInternListJob.postedAt` (`internListAdapter.ts:37`) and `AtsJob.postedAt` (`src/lib/ats/types.ts:11`); persisted into `postingDate` |
| `publishedAt` | exists only inside the Ashby adapter response (`ashby.ts:32` reads `j.publishedAt` → `postedAt`) |
| `datePosted` | did not exist |
| `discoveredAt` | did not exist on `Job` (only on `NearbyFirm`); `firstSeenAt` is the equivalent |
| `createdAt` | exists (row-insert time) |
| `updatedAt` | exists (row-write time) |
| `firstSeenAt` | exists |
| `lastSeenAt` | exists |
| `verifiedAt` | exists as `lastVerifiedAt` |
| `scoredAt` | exists as `scoringFinishedAt` |
| `sourceRowIndex` | **did not exist** — the source's row order was discarded at parse time |
| `sourceCapturedAt` | **did not exist** — the sync fetch timestamp was never persisted per job |

---

## 2. Trace: InternList row date → screen

1. **Source row.** `https://jobright.ai/minisites-jobs/intern/us/engineering_development?embed=true`
   embeds `__NEXT_DATA__` with `props.pageProps.initialJobs[]`. Each item carries
   `postedDate` as an **epoch-milliseconds number**. The "38 minutes ago" text the
   user sees on intern-list.com is that same timestamp rendered relative to page
   load — the source is exposing an absolute instant, not a relative string.
2. **Extraction.** `src/lib/sync/internListAdapter.ts:105`
   `postedAt: typeof j.postedDate === "number" ? new Date(j.postedDate) : null`.
   Only the numeric form was understood; any string form (`"38 minutes ago"`,
   `"2026-07-31"`) fell through to `null`. **The array position was discarded.**
3. **Normalization.** `src/lib/sync/ingest.ts:394` copies `raw.postedAt` into
   `NormalizedJobInput.postedAt`. No timezone handling was needed (epoch ms is
   already an instant); values are stored by Prisma as UTC ISO text.
4. **Persistence.** `ingest.ts:277` writes `postingDate: input.postedAt` **inside
   `prisma.job.create` only**. The rediscovery branch (`ingest.ts:245`) never
   touches `postingDate` — so the value was already stable across syncs, which is
   the one part of the desired behaviour that already worked.
5. **Jobs page query.** `GET /api/jobs` (`src/app/api/jobs/route.ts:97`):
   ```ts
   orderBy: [{ createdAt: "desc" }, { id: "desc" }]
   ```
   `postingDate` was used **only** as an optional `postingDateFrom/To` filter
   (`route.ts:49`). It was never part of the ordering.
6. **UI date display.** `src/components/JobCard.tsx:46`
   `postingAge(job.postingDate ?? job.firstSeenAt ?? null)`, rendered as
   `Posted {age}`. `postingAge` (`src/components/VerificationBadge.tsx:48`)
   computed **whole days only**:
   ```ts
   const days = Math.floor((Date.now() - date.getTime()) / 86400000);
   if (days <= 0) return "today";
   ```
   So everything under 24 h collapsed to "today" — minutes/hours were never shown.
7. **Default sorting.** No client-side sort existed; the page rendered
   `jobs.map(...)` in exactly the order the API returned (`page.tsx:394`).

---

## 3. Current database ORDER BY (before the fix)

```ts
// src/app/api/jobs/route.ts:97
orderBy: [{ createdAt: "desc" }, { id: "desc" }]
```

Pagination (`route.ts:121-125`) slices that same array in memory, so every page
inherited the `createdAt` order.

## 4. Client-side sorting

None. `src/app/jobs/page.tsx` did no sorting of its own, offered no sort control,
and had no `sort` query parameter. Filters were held in React state only and were
never reflected in the URL.

## 5. Status grouping that overrides date sorting

None found, and that is worth stating precisely because it was a plausible
suspect:

- `scoringState` (`NOT_SCORED | QUEUED | SCORING | SCORED | …`) never appears in
  `orderBy`. The "Scoring" chip (`JobCard.tsx:93`) is display-only.
- `verificationStatus` and `activeFeed` act as **`where` filters** (`route.ts:74-82`),
  not as sort keys.
- `matchScore` acts as a `where` filter (`matchScoreMin`), not as a sort key.

So the wrong order was **not** caused by grouping — it was caused purely by the
sort key being the local insert time.

---

## 6. Root cause — why old jobs appear above recent jobs

`createdAt` is *when this app inserted the row*, which is unrelated to *when the
employer posted the job*. The two diverge sharply whenever a bulk backfill runs.

Measured evidence from `dev.db`:

- The ATS migration run at **2026-08-01T23:55** inserted ~140 Greenhouse / Lever /
  Ashby rows in one batch. Those rows have the **highest `createdAt` in the whole
  table**, so they occupied the entire first page.
- Their actual `postingDate` values are **2026-06-10 … 2026-07-29** — i.e. the
  "8 days ago / 15 days ago / 26 days ago / 1 month ago / 3 months ago" cards the
  user reported.
- Meanwhile the freshest InternList rows (`postingDate` **2026-08-01T11:04**,
  `2026-08-01T09:07`, `2026-08-01T08:15` — hours old) were inserted at
  `createdAt` 2026-08-01T22:11 and therefore sorted *below* the 23:55 ATS batch.

Top of the feed under the old ORDER BY, with the two dates side by side:

| # | Job | source | `postingDate` (real age) | `createdAt` (sort key) |
| --- | --- | --- | --- | --- |
| 1 | Part-Time Student Worker — Zoox | lever | 2026-07-23 (9 days) | 2026-08-01T23:55:16 |
| 2 | Part-Time Student Worker — Zoox | lever | 2026-07-02 (30 days) | 2026-08-01T23:55:16 |
| 6 | Site Civil Engineer Co-op — Woolpert | greenhouse | 2026-07-23 (9 days) | 2026-08-01T23:55:15 |
| 11 | Lightspeed Network Eng — Telesat | lever | 2026-06-12 (50 days) | 2026-08-01T23:55:11 |

versus what the source order should have produced:

| # | Job | source | `postingDate` |
| --- | --- | --- | --- |
| 1 | Civil Engineering Intern | intern-list | 2026-08-01T11:04 |
| 2 | Architecture Student Intern | intern-list | 2026-08-01T09:07 |
| 3 | Geotechnical Engineering Intern | intern-list | 2026-08-01T08:15 |

**Root cause, one sentence:** the default feed was ordered by local row-insert
time (`createdAt`) instead of the source posting timestamp, so any bulk import of
older postings jumped straight to the top of the page.

Contributing (secondary) causes:

- **B.** The source posting timestamp had no canonical, confidence-tagged home —
  `postingDate` mixed exact instants (`intern-list`, `lever`, `ashby`),
  "last updated" instants (`greenhouse` uses `updated_at`, `greenhouse.ts:30`),
  date-only values (manual entry) and nulls (`workday.ts:98`, `generic.ts:99`)
  with no way to tell them apart or to rank unknowns last.
- **C.** Relative source text was never parsed at all — `workday.ts:98` explicitly
  discards `postedOn` ("Posted Today"), and the InternList adapter ignored any
  string date form.
- **D.** The source's own row order was thrown away, so there was no tiebreaker
  when timestamps are equal or missing.
- **E.** The card's age text had day granularity, so a genuinely 38-minute-old
  posting and a 20-hour-old posting both rendered as "Posted today" — the feed
  looked stale even where it was ordered correctly.

## 7. Records where the source date is missing

At audit time: **0 of 533** rows had a null `postingDate`. Every source currently
in the database (intern-list, greenhouse, lever, ashby, ats:greenhouse, and 3
legacy manual rows) supplied one.

Missing-date rows are still possible going forward — `workday.ts` and
`generic.ts` both hardcode `postedAt: null` — so the ordering must place
unknown-date jobs after known ones rather than assuming the column is populated.
Confidence for the existing rows after backfill:

- `EXACT` — a real instant from the source (intern-list epoch ms, lever
  `createdAt`, ashby `publishedAt`, greenhouse `updated_at`, smartrecruiters
  `releasedDate`).
- `DATE_ONLY` — midnight-aligned values with no time component (the 3 legacy
  manual rows: `2026-05-15T00:00:00Z`, `2026-06-01T00:00:00Z`, `2026-07-01T00:00:00Z`).
- `UNKNOWN` — no source date at all (none today).

---

## 8. What changed as a result of this audit

- Canonical field `Job.sourcePostedAt` (+ `sourcePostedText`,
  `sourceDateConfidence`, `sourceCapturedAt`, `sourceSyncRunId`, `sourceRowIndex`).
- Default ORDER BY is now `sourcePostedAt DESC` (unknown last) → latest-sync
  `sourceRowIndex ASC` → `firstSeenAt DESC` → `id DESC`.
- Relative and absolute source date text is parsed against the sync capture time
  (`src/lib/sync/sourceDate.ts`).
- The card shows minute/hour/day-accurate source age, recomputed for display only.
- `sort` is a URL query parameter with `newest` as the default.

See the final report for the file-by-file list.
