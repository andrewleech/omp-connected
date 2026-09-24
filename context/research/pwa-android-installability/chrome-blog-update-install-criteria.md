---
timestamp: 2026-09-24T20:08:30Z
research_topic: "PWA installability and Android (Chrome) best practice 2025-2026"
query: "service worker fetch handler install requirement"
source_url: https://developer.chrome.com/blog/update-install-criteria
source_name: Chrome blog: Revisiting Chrome's installability criteria
relevance: High
---

## Source
[Chrome blog: Revisiting Chrome's installability criteria](https://developer.chrome.com/blog/update-install-criteria)

## Query Context
service worker fetch handler install requirement

## Key Findings
- "we have removed the requirement to have a service worker that implements the fetch() method for installation from the menu, since version 108 on mobile and 112 on Desktop."
- At time of writing (2023-12) prompt still required fetch handler; Chromium commit ca9ded6828 (Aug 2024, Chrome 129) 'Cleanup installable manager ServiceWorker related code. The SW check is no longer used.'

## Relevance Notes
Used for the PWA Android installability checklist.
