# Autofill Phase 1 baseline audit

Baseline: `5e5713f4eb066311b69d0b95d42cb835b0153b2e` on `agent/full-publish-readiness-audit`.

## Exact baseline flow

The job page called `applyWithApplicationAgent`, required pre-generated documents, fetched their PDF bytes and the current profile, posted an application bundle to a namespaced window bridge, waited for an acknowledgement, and opened the official employer URL. Separately, the application worker created an `ApplicationRun`, opened Chromium, injected the extension, asked the backend for a fill plan, applied it, and let Playwright click Continue. These were two distinct flows: the extension had no listener for the website bundle, so the normal website button could not receive an acknowledgement or start employer-page autofill.

## Currently works at the baseline

- Legacy queued-run extension fixtures fill ordinary text inputs with the native value setter and retain values in the existing controlled-input fixture.
- Standard selects, radios, checkboxes, and a standard résumé file input have basic support in the queued-run path.
- CAPTCHA, password/login, OTP, and assessment detection exist.
- The worker distinguishes Continue from final Submit, bounds its loop to ten pages, and does not click the final action.
- Backend document routes reject non-QA, identity-invalid, wrong-job documents attached to an `ApplicationRun`.

## Partially works at the baseline

- React retention is tested for a small set of ordinary inputs, but post-fill verification is absent for most controls.
- ARIA comboboxes are scanned, but only already-visible options are considered and no searchable-combobox fixture exists.
- Custom dropdown matching is substring-based, with no confidence threshold or safe semantic synonyms.
- Multi-page navigation exists only in the worker/queued-run flow; a page change is not robustly proven for SPA steps.
- Long answers are filled only when an exact approved answer or narrow legacy lookup exists; contextual generation is absent.
- Required flags are sent to the server, but there is no complete post-fill audit of every visible required control.
- Document upload verifies `input.files` only indirectly and has no bundle-level freshness fingerprint.

## Broken at the baseline

- The website application-bundle bridge has no extension receiver. “Apply with Application Agent” cannot complete its handoff.
- The website opens a new employer tab only after an acknowledgement that the installed extension cannot produce.
- The direct Apply flow and queued `ApplicationRun` flow are not synchronized, which accounts for queued/no-action and page-open/no-fill failures.
- Apply is disabled until the user manually generates a résumé; document readiness is not automatic.
- No deterministic freshness check prevents reuse after a JD, approved fact, match result, template, or policy changes.

## Missing at the baseline

- One authoritative recoverable bundle used directly on the employer page.
- Canonical field descriptors/classification covering custom controls.
- Semantic decline-option matching, country/state/month equivalence, and confidence-scored selection.
- Employer-scoped relationship answers in the executor.
- Explicit `ACCOUNT_CREATION_REQUIRED` handling.
- Direct-flow state transitions with timestamp, reason, page URL, and safe metadata.
- Greenhouse, Lever, Workday, generic, and custom React Phase 1 fixture coverage.

The implementation on the autofill branch addresses these baseline findings without changing discovery/provider logic.
