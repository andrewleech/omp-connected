---
timestamp: 2026-09-24T20:08:30Z
research_topic: "PWA installability and Android (Chrome) best practice 2025-2026"
query: "dates of changes"
source_url: https://github.com/chromium/chromium
source_name: Chromium commit history (GitHub mirror) + chromiumdash milestones
relevance: High
---

## Source
[Chromium commit history (GitHub mirror) + chromiumdash milestones](https://github.com/chromium/chromium)

## Query Context
dates of changes

## Key Findings
- b38a752615 2023-08-16 Remove SW offline capability check.
- 78df6183cd 2024-07-15 (M128) Remove flags kUniversalInstallManifest/Icon 'launched for a few months'.
- 8388410e57 2024-08-20 (M130) Cleanup Android universal install flags.
- ca9ded6828 2024-08-16 (M129) SW check no longer used.
- crrev 5919834 2024-10-10 (M131) BypassAppBannerEngagementChecks default on; b3bb1b4631 (M133) removed code.
- 4b86788ec9 2025-11-18 (M144) auto-minted TWA flag (disabled by default).
- 6c704fe8c1/ff5777f1cb 2026-08-03 (M153, stable 2026-09-08) always show Install/Create shortcut disambiguation dialog; Install disabled when device cannot mint APK (e.g. offline).

## Relevance Notes
Used for the PWA Android installability checklist.
