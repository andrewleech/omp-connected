---
timestamp: 2026-09-24T20:08:30Z
research_topic: "PWA installability and Android (Chrome) best practice 2025-2026"
query: "Chrome install criteria"
source_url: https://web.dev/articles/install-criteria
source_name: web.dev: What does it take to be installable?
relevance: High
---

## Source
[web.dev: What does it take to be installable?](https://web.dev/articles/install-criteria)

## Query Context
Chrome install criteria

## Key Findings
- Last updated 2024-09-19. Lists: not installed; engagement (click + 30s); HTTPS; manifest with short_name|name, icons 192+512, start_url, display in fullscreen|standalone|minimal-ui|window-controls-overlay, prefer_related_applications absent/false.
- No service worker requirement listed.
- Engagement heuristic appears stale vs Chromium source: BypassAppBannerEngagementChecks default-enabled M131 (crrev 5919834), code removed M133 (b3bb1b4631).

## Relevance Notes
Used for the PWA Android installability checklist.
