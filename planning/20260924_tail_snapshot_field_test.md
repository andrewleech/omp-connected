# Tail snapshot: phase 2 review fixes and phase 3 field test on hub-host

Date: 2026-09-24
HEAD: c046df93c5 (omp-connected, uncommitted work); fork `collab-tail-snapshot` at 0e7a78e4d (local, not pushed)

## Phase 2 closure
- d1239513c: tail join, earlier-history paging, T10 reconnect (tail_p2_web_tail_history).
- b78c5f483: tap to load images, clipped output and whole entries (tail_p2_web_load_full).
- 0e7a78e4d: adversarial-review fixes. The guest drops rows a page repeats (duplicate React keys otherwise) and treats "no new rows but hasEarlier" as an error, which stops the near-top loader from re-requesting forever. Both fixes are mutation-checked.
- Standard review: correct, no findings (confidence 0.93). collab-web tests: 121 pass.

## Deployment on hub-host (no push)
- The hub's `/collab/` guest was built from the local fork: `COLLAB_WEB_SRC=~/src/oh-my-pi/packages/collab-web bun run build`, then `omp-hub` was restarted.
- The stock build is kept at `/tmp/hub-collab-stock/`. Roll back: `cp -R /tmp/hub-collab-stock/. hub/dist/webui/collab/`, or rebuild without `COLLAB_WEB_SRC`.
- `.gitmodules` and the submodule pin are unchanged. They need the branch pushed to the fork, which needs user approval.

## Measurements (headless Chromium, 1600×1125, via the hub's `/collab/` and relay :7466)
| Case | Result |
|---|---|
| Fork `omp` (cwd /tmp) resuming the phase 0 session, join | 0.54–0.60 s to "live" with the load-earlier control (3 runs); **1,045,308 bytes in 5 frames** |
| Same session, stock host (phase 0 measurement) | 23.3 MB train; the stock guest had not settled after 29 s |
| Page back to Turn 0 via "load earlier" | 1194 rows; the scroll position stayed on the reading row |
| Tap to load the 2.7 MB screenshot (tool card expanded) | Rendered 836×836 PNG in 0.54 s |
| Fork guest against a stock 18.2.9 host (ESP32 session, view link) | Full snapshot, rows in 0.6 s, no load-earlier or load controls, read-only view normal |

## Not done
- **Harness under the fork host (Q2).** It needs the user's go-ahead to restart that live session. Until then the harness uses the fallback path (stock host, full 26.5 MB snapshot) with the fork guest.
- The headless browser can't be used on the dashboard while the harness is selected: the tab hangs while its 26.5 MB snapshot renders. That's the problem this track fixes; it goes away once the harness runs a fork host.
- Submodule URL/branch/pin (tail_p3_hub_integration): blocked on pushing the fork branch.
