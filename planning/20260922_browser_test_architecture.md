# Browser-test architecture decision

Date: 2026-09-22
HEAD: ea1ccb0695

## Decision D7
Adopt **Playwright Test directly in TypeScript** for Hub browser acceptance tests and GitHub Actions CI. Do not add Robot Framework.

## Evidence and rationale

- Hub is already Bun/TypeScript (`hub/package.json`, `hub/tsconfig.json`) and has no Python toolchain or GitHub workflow. Direct Playwright keeps test language, package manager, types, failure output, fixtures, and code review in the existing ecosystem.
- Playwright’s official CI documentation provides a GitHub Actions workflow, browser installation, HTML report artifacts, and recommends one worker in CI for stability. It documents `webServer` lifecycle management and `baseURL` for local integration tests. Sources: https://playwright.dev/docs/ci and https://playwright.dev/docs/test-webserver
- Playwright recommends role/label/test-id locators, web-first retrying assertions, isolated browser contexts, and traces on first retry — the required anti-flake discipline. Source: https://playwright.dev/docs/best-practices
- Robot Framework Browser is powered by Playwright but adds Python, pip, `robotframework-browser`, and `rfbrowser init` on top of Node/browser setup. Its keyword DSL provides no advantage for this TypeScript application and creates a second toolchain. Source: https://docs.robotframework.org/docs/different_libraries/browser

## CI shape

Create one GitHub Actions workflow with a dedicated Chromium Playwright job on `ubuntu-latest`, pinned action major versions, Bun setup, frozen dependency install, `playwright install --with-deps chromium`, and `bun run test:e2e`. Set one worker under CI; retries only in CI; upload HTML report, trace, screenshot, and video artifacts only for failed/retried tests with short retention. Do not cache browser binaries: Playwright advises against it.

Start Chromium-only in CI. It deterministically covers Hub DOM state, iframe preservation, and mocked transport. Keep real Safari iOS/Chrome Android validation as a release matrix; add WebKit emulation only after first stable suite and after showing it catches a Hub-specific defect.

## Test architecture

- Add `@playwright/test`, `playwright.config.ts`, `hub/tests/e2e/`, and an explicit `test:e2e` script.
- Playwright `webServer` starts a deterministic Hub test server with test-only in-process fake agent/Collab responses. Tests never reach tailnet hosts, the live reference, or the external guest source.
- Use accessibility-first locators. The fixture controls `/api/hosts`, session list/link payloads, dashboard events, and an iframe test guest; it can assert access request payloads and issue delayed/stale results.
- Persist only browser-observable contracts: writable control default; view-only fallback; stale selection safety; status-bar visibility; left/right drawer focus/close behavior; unchanged iframe node/src through poll and drawer changes; mobile viewport layout.
- No visual snapshot baselines in the first suite. They are sensitive to browser/font/image drift and add maintenance before behavior coverage is stable.

## Exit criteria

A PR runs Bun unit tests and deterministic Chromium browser acceptance tests in GitHub Actions. Failure artifacts expose trace/report evidence. The tests need no credentials, external network, sleeping, random ports, or ordering dependencies.
