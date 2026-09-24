# Hub: add deterministic Playwright acceptance CI

Phase: 3
Depends on: Phases 0–2
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
D7 selects direct TypeScript Playwright rather than Robot Framework. The suite must validate browser-observable dashboard contracts without contacting tailnet or the external Collab guest.

## Scope
In: Playwright dependency/config, deterministic Hub fixture server, Chromium GitHub Actions job, core responsive/control tests, failure artifacts. Out: visual-regression baselines, external integration tests, and a Python test toolchain.

## Files and anchors
- `hub/package.json:11-20`, `hub/tsconfig.json`: scripts/test TypeScript.
- No `.github/workflows` exists at planning time; create the workflow in the repository’s established CI location once revalidated.
- `hub/src/server/index.ts` and dashboard API seams: derive a test-only deterministic server fixture without production test backdoors.
- `planning/20260922_browser_test_architecture.md`: D7.

## Design constraints
Use a single Chromium worker in CI; isolated contexts; user-facing role/label/test-id locators and web-first assertions; no arbitrary sleeps; no network to live services; no browser-binary cache. Upload reports/traces only on failure/retry because artifacts can contain test execution data.

## Acceptance criteria and tests
- GitHub Actions starts local Hub fixture/server and runs Chromium on push/PR.
- Tests prove default control, view-only fallback, stale selection rejection, drawer focus/close behavior, and iframe continuity through refresh/drawer state.
- Tests run deterministically offline except package/browser installation.
- Failed CI job uploads actionable Playwright report/trace artifacts.

## Workflow shape
Implementation and test authoring together; CI/security review of artifacts and fixtures; repeat runs to expose flake before requiring the check.

## Open questions
None. WebKit expansion remains deliberately deferred after Chromium reliability evidence.
