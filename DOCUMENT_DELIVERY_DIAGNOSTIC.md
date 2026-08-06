# Document delivery diagnostic

Why tailored documents generated on Internship Pilot never reached the extension,
and what was changed.

## The reported symptom, and why its evidence was misleading

> Chrome DevTools Network filtered for port 4317 shows zero requests after
> document generation. Therefore the website never sends the generated PDF
> documents to the local Agent server.

The observation is accurate; the inference from it is not. Delivery runs inside
the Next.js **server** process (`generateDocumentsForJob` → `fetch` to
`127.0.0.1:4317`), not in the page. A server-to-server request never appears in
the browser's Network tab, so DevTools would show zero requests to 4317 whether
delivery was working perfectly or not.

That matters because it means the missing piece was never a missing call. The
call was already there, it was firing on every generation, and it was failing.

## The active path

| Step | Location |
| --- | --- |
| Generation UI handler | `src/app/jobs/[id]/page.tsx` → `generateDocuments()` → `runTailoredDocumentGeneration` (`src/lib/documents/client.ts`) |
| Generation API route | `POST /api/jobs/[id]/generate-documents` (`src/app/api/jobs/[id]/generate-documents/route.ts`) |
| Generation implementation | `generateDocumentsForJob` (`src/lib/documents/generate.ts`) |
| PDF storage location | `data/generated/<jobId>/resume-v<N>.pdf`, `cover-letter-v<N>.pdf`; the path is recorded on `GeneratedDocument.storagePath` |
| PDF retrieval route (website) | `GET /api/documents/[id]/download` |
| Raw PDF bytes | Read from disk with `readFile` during generation, and re-read from `storagePath` for a resend |
| Agent document upload route | `POST http://127.0.0.1:4317/documents/latest` (`agent-server/src/api/latest-documents.ts` in Internship-Agent-Recovery) |
| Agent retrieval routes | `GET /documents/latest`, `GET /documents/latest/:id/content` |
| Delivery function (website) | `deliverDocumentToAgent` (`src/lib/documents/agentDelivery.ts`) |

## Root cause

**The two processes were configured with different tokens, so every delivery was
answered with HTTP 401 and recorded as a failure that nothing displayed.**

The agent generates its token on first run and writes it to
`local-data/agent-token.txt`. Internship Pilot's `.env` held a *copy* of an
earlier token. Recreating the agent's data directory rotated the real token and
left the copy stale — silently, because nothing compares them.

Measured against the live agent:

```
x-agent-token: 273f83ce…  (Internship-AI .env)               → HTTP 401
x-agent-token: b2b04b6d…  (agent local-data/agent-token.txt) → HTTP 200
```

Two things then hid the failure completely:

1. `deliverDocumentToAgent` returns a failure outcome rather than throwing — correct,
   because a résumé that passed QA should not be discarded when the agent is
   closed — but the outcome was never returned past `generateDocumentsForJob`.
   The API route dropped it, so the page could not have shown it.
2. A 401 was reported with the same generic wording as any other refusal, so even
   a logged outcome would not have pointed at the token.

## Changes

- **`src/lib/documents/agentDelivery.ts`** — `resolveAgentToken()` reads the agent's
  own token file (`INTERNSHIP_AGENT_TOKEN_FILE`) at request time and falls back to
  `INTERNSHIP_AGENT_TOKEN`. A file that both processes read cannot drift the way a
  pasted copy does. 401/403 is now reported as an authentication problem naming the
  setting to fix. The token is sent only in the `x-agent-token` header — never in a
  URL, a log line, a UI string, or document metadata.
- **`src/app/api/jobs/[id]/generate-documents/route.ts`** — returns `agentDelivery`
  alongside the document ids.
- **`src/lib/documents/client.ts`** — carries the delivery report to the page; adds
  `sendLatestDocumentsToExtension`.
- **`src/lib/documents/deliverLatest.ts`** (new) — re-reads the newest QA-passed
  résumé and cover letter from disk and re-sends them. Only `qaStatus: "pass"`
  versions are eligible: an archived document is never put in front of an employer.
- **`src/app/api/jobs/[id]/deliver-documents/route.ts`** (new) — `POST`, delivery only.
- **`src/app/jobs/[id]/page.tsx`** — a "Send latest documents to extension" button and a
  per-document status: *Generated*, *Generated · Sent to extension*, or
  *Generated · Delivery failed* with the reason. "Sent to extension" is rendered only
  when the agent returned an acknowledgement.

## Agent contract

`POST http://127.0.0.1:4317/documents/latest`

- Header `x-agent-token: <token>`, `content-type: application/json`
- Body: `documentType` (`resume` | `cover_letter`), `filename`, `mimeType`
  (`application/pdf` only), `source` (`tailored` | `default`), optional `company`,
  `jobTitle`, `jobId`, `createdAt`, `checksum` (lowercase hex SHA-256 of the raw
  bytes), `contentBase64`
- Response `201 { ok: true, data: <record with id, byteLength, checksum> }`
- The agent recomputes the checksum and refuses the upload if it disagrees, so a
  corrupted transfer is never stored.

## Verified

Real generated PDFs, the real delivery function, the running agent on 4317:

| Check | Result |
| --- | --- |
| Résumé upload | HTTP 201, id `229cabfd-…` |
| Cover-letter upload | HTTP 201, id `44332e70-…` |
| Stored on disk | 63,279 B and 54,910 B under `local-data/documents/` |
| Checksums | Byte-identical to the source PDFs in `data/generated/` |
| `GET /documents/latest` | Returns both, each pointing at its own document |
| Agent log | `latest tailored document stored` with id, type, source, byteLength — no bytes, no token |

`src/lib/documents/agentDelivery.integration.test.ts` covers the same path against a
test agent over a real socket, including the token-mismatch case that caused this.
