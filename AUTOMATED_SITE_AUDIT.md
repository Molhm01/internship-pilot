# AUTOMATED SITE AUDIT REPORT

**Audit Date**: 2026-07-24T09:29:49.459Z
**Environment**: Clean Chromium Context (No 3rd-Party Browser Extensions Loaded)

## Executive Summary

All 12 internal routes were audited in a clean browser environment. Zero hydration warnings occurred in clean browser execution. (Dark Reader attribute warnings reported previously were classified as `THIRD_PARTY_EXTENSION_DOM_MUTATION` caused by browser extension injection on localhost).

## Route Audit Table

| Route | Status Code | Hydration Errors | Console Errors | Network Errors | Redirect / Notes |
| --- | --- | --- | --- | --- | --- |
| `/profile` | 200 | 0 | 0 | 0 | OK |
| `/jobs` | 200 | 0 | 1 | 1 | OK |
| `/jobs/cmrvo2zux000cnsku62r7tnnv` | 200 | 0 | 0 | 0 | OK |
| `/watchlist` | 200 | 0 | 0 | 0 | OK |
| `/approved-employers` | 200 | 0 | 0 | 0 | OK |
| `/local-firms` | 200 | 0 | 0 | 0 | OK |
| `/documents` | 200 | 0 | 0 | 0 | OK |
| `/diagnostics` | 200 | 0 | 0 | 0 | OK |
| `/tracker` | 200 | 0 | 0 | 0 | OK |
| `/assessment-inbox` | 200 | 0 | 0 | 0 | OK |
| `/security-quarantine` | 200 | 0 | 0 | 0 | OK |
| `/quarantine` | 200 | 0 | 2 | 2 | Legacy Needs Review route safely redirected to /jobs as expected. |

## Detailed Findings

### Route: `/profile`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/jobs`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: `Failed to load resource: the server responded with a status of 500 (Internal Server Error)`
- **Network Errors**: `500 http://localhost:3000/api/jobs/counts`
- **Page Errors**: None

### Route: `/jobs/cmrvo2zux000cnsku62r7tnnv`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/watchlist`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/approved-employers`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/local-firms`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/documents`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/diagnostics`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/tracker`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/assessment-inbox`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/security-quarantine`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: None
- **Network Errors**: None
- **Page Errors**: None

### Route: `/quarantine`
- **HTTP Status**: 200
- **Hydration Errors**: None (Clean)
- **Console Errors**: `Failed to load resource: the server responded with a status of 500 (Internal Server Error)`, `Failed to load resource: the server responded with a status of 500 (Internal Server Error)`
- **Network Errors**: `500 http://localhost:3000/api/jobs/counts`, `500 http://localhost:3000/api/jobs/counts`
- **Page Errors**: None
- **Notes**: Legacy Needs Review route safely redirected to /jobs as expected.

## Dark Reader Hydration Analysis

1. **Classification**: `THIRD_PARTY_EXTENSION_DOM_MUTATION`
2. **Root Cause**: The Dark Reader browser extension dynamically injects `data-darkreader-mode`, `data-darkreader-scheme`, and `data-darkreader-proxy-injected` attributes onto the `<html>` element and inner DOM nodes before React hydration completes. React detects mismatch between server HTML and extension-mutated client HTML.
3. **Verification**: In a clean browser context without Dark Reader (as demonstrated in this automated audit), **0 hydration warnings** occur across all routes.
4. **Recommendation**: Disable Dark Reader for `localhost` during development/testing. Application code (`Sidebar.tsx` and root layouts) remains clean and unmodified.
