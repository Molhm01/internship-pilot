# Autofill Phase 2 audit

## Scope and safety

This pass used bounded headless Chromium sessions against public pages only. No personal data, résumé bytes, cover-letter bytes, credentials, CAPTCHA responses, or employer submissions were entered. Every browser context was closed after each inspection.

## Real ATS validation

| Target | Observation | Result |
| --- | --- | --- |
| Greenhouse — Freeform | 48 visible controls, 23 required; identity/contact, autocomplete, résumé/cover-letter, education, links, long-answer, EEO, and final Submit application controls recognized. A visible CAPTCHA caused an immediate user-intervention pause. | PASS for safe recognition and pause; execution intentionally not attempted without an approved candidate profile |
| Lever — Palantir | 86 visible controls, 55 required; full name, contact, links, radio/select/checkbox groups, long-answer textareas, résumé, and final Submit application recognized. A visible CAPTCHA caused an immediate pause. | PASS for safe recognition and pause; execution intentionally not attempted without an approved candidate profile |
| Workday — NVIDIA | Public `/apply` boundary rendered a sign-in-only Workday shell with no form controls. | PASS: `AUTHENTICATION_REQUIRED`, no retry loop |
| Custom React — Ashby/Cohere | Public application form rendered after the non-final “Apply for this Job” navigation: 18 controls, 7 required, résumé upload, autocomplete, free-response questions, and final Submit Application. | PASS for safe recognition; execution intentionally not attempted without an approved candidate profile |

## Phase 1 flow trace

The running code follows the intended order: job-page Apply reserves a blank employer tab, checks bridge availability, calls automatic document readiness, computes/reuses the job fingerprint, fetches the canonical profile/company-scoped context, transfers one bundle, waits for extension storage acknowledgement, and only then navigates the reserved tab. The extension persists that bundle in session storage, matches the employer URL, scans fresh DOM/accessibility fields on each page, pauses for blockers/unresolved questions, verifies retained values, audits required controls, and never invokes a final action.

## Real findings and targeted changes

- Workday can redirect directly to a sign-in-only shell without the phrase “Start Your Application”. The engine now detects the `CAREERS AT` + visible `Sign In` + no form-controls boundary and returns `AUTHENTICATION_REQUIRED`.
- Ashby exposes a plain `Name` field and an availability question. Classification now maps standalone `Name` to `FULL_NAME` and internship availability wording to `START_DATE`.
- A Greenhouse `Country*` autocomplete was initially classified as `PHONE` because its section was named “Phone”. Classification now prioritizes direct field identity over section text and maps it to `COUNTRY`.
- The custom Ashby page required CSP-safe engine injection at document start; the real-ATS harness now uses `addInitScript` rather than late inline injection.

## Document integrity

The Phase 1 fingerprint matrix remains green for same-input reuse and invalidation on JD, approved facts, match evidence, template/source, policy, QA, identity, job, and user changes. Website readiness, extension background validation, and upload execution each verify job identity, fingerprint, QA status, identity verification, MIME, byte length, and exact bytes. No filename-only trust exists.

## Safety and recovery

CAPTCHA, MFA/OTP, authentication/account creation, legal/sensitive questions, unknown required controls, and unsupported controls pause without changing the bundle. The authoritative bundle retains job ID, fingerprint, documents, page URL, and transitions. Existing bundle E2E covers refresh, SPA navigation, recovery storage, duplicate prevention, exact uploads, and final-submit blocking. No real public page was submitted.

## Bounded limitation

Real-world field execution was not performed because this pass did not receive an approved candidate profile and entering synthetic identity data into employer forms would violate the no-fabrication rule. Execution remains covered by sanitized Greenhouse, Lever, Workday, generic, custom React, React-retention, file-upload, multi-page, and safety fixtures.

## Final report

AUTOFILL PHASE 2: PARTIAL

CURRENT HEAD:
260720c480c895f786e1503d00e9899e4c331858 (Phase 2 implementation commit)

BRANCH:
agent/autofill-application-agent

REAL ATS VALIDATION:
- Greenhouse: PASS for read-only DOM/accessibility recognition, blocker detection, required-control discovery, and final-action detection; live execution not attempted without approved profile data.
- Lever: PASS for read-only DOM/accessibility recognition, long-answer discovery, blocker detection, required-control discovery, and final-action detection; live execution not attempted without approved profile data.
- Workday: PASS; sign-in-only boundary returns AUTHENTICATION_REQUIRED and does not retry.
- custom React: PASS for Ashby/Cohere form recognition and final-action detection; live execution not attempted without approved profile data.

DOCUMENT INTEGRITY:
- fingerprint: PASS
- stale rejection: PASS
- wrong-job rejection: PASS
- QA rejection: PASS

FIELD RESULTS:
- text: sanitized execution PASS; real controls recognized
- textarea: sanitized execution PASS; real free-response controls recognized
- selects: sanitized execution PASS; real controls recognized where present
- ARIA combobox: sanitized execution PASS; real autocomplete controls recognized
- autocomplete: sanitized execution PASS; Greenhouse/Ashby controls recognized
- radio: sanitized execution PASS; Lever controls recognized
- checkbox: sanitized execution PASS; real controls recognized
- file: sanitized exact-byte upload PASS; real upload controls recognized
- React retention: PASS in deterministic controlled-form E2E

REQUIRED FIELD AUDIT:
- FILLED: PASS in sanitized execution
- NEEDS_USER: PASS
- UNSUPPORTED: PASS
- BLOCKED: PASS
- silent skips: 0 in deterministic suites; live execution was intentionally not attempted

FREE RESPONSE:
- grounded: PASS in sanitized execution
- fabricated claims: 0
- AI-offline behavior: PASS; unsupported contextual answers remain NEEDS_USER

STATE RECOVERY:
- refresh: PASS
- SPA navigation: PASS
- extension recovery: PASS in bundle E2E
- duplicate prevention: PASS

SAFETY:
- CAPTCHA: pauses
- MFA: pauses
- account creation: pauses
- legal/sensitive: pauses
- final-submit guard: PASS
- accidental submissions: 0

REGRESSION TESTS ADDED:
- Workday sign-in-only authentication boundary
- Country field inside a Phone section
- Ashby standalone Name, Website, internship availability, and preferred-posting-location classification
- CSP-safe real-ATS reconnaissance harness

TESTS:
Local unit (860 passed, 20 skipped), fixture, extension, build, Prisma, Windows asset, and real-ATS reconnaissance gates passed. The real-ATS harness entered no personal data and submitted nothing.

CI:
[Workflow run 32681532900](https://github.com/Molhm01/internship-pilot/actions/runs/32681532900): all 9 jobs passed.

KNOWN LIMITATIONS:
Real form execution with candidate identity/documents remains intentionally unperformed until an approved profile is explicitly supplied for a controlled test. Public Greenhouse and Lever pages exposed CAPTCHA blockers; Workday exposed authentication before fields; Ashby execution was not attempted.

SAFE FOR BROADER REAL-MACHINE NO-SUBMIT TESTING:
YES for read-only reconnaissance and sanitized/local execution; live form filling requires an explicitly approved candidate profile.
