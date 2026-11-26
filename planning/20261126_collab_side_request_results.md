# Collab side requests: browser smoke and provider cache check

Sprint: [Collab side requests](20261124_collab_side_request_sprint.md)
Ticket: [Verify the integrated flow](tickets/side_request_4_verification.md)
Date: 2026-11-26

Local verification only. Nothing was deployed, pushed or run against a live hub. This report covers the browser smoke and the provider cache check; the unit, integration, build and type checks are recorded separately by the main agent.

## Environment

| Item | Value |
|---|---|
| Fork worktree | `collab-side-request`, host process started at fork commit `3390b2b67d` (runtime commit recorded in the session file); the guest bundle was built from the same tree. Later commits only touched `packages/coding-agent/src/task/side-request.ts` and its test |
| Dashboard | omp-connected `main` at `fc36eb6` (popover side request mode), exported with `git archive HEAD hub extension install.sh README.md` into a temp directory |
| Runtime | Bun 1.4.2 for the hub, Bun 1.4.4 for omp (the fork needs >= 1.4.4), Node 25 and Playwright 1.63 with its headless Chromium build 1243 for the browser scripts |
| Provider | anthropic, model `claude-haiku-5-5`, thinking `low`, user's normal auth |
| Hub | `127.0.0.1` only, dashboard port 48160, relay port 47466 |
| Host session | fork omp from source with the omp-connected extension from the temp copy, cwd under `/tmp/side-smoke` |
| Viewports | desktop 1440x900 mouse; mobile Playwright "iPhone 13" device (touch, isMobile), holds sent as CDP touch events |

The guest bundle was built from the fork tree and placed under `dist/webui/collab` of the temp copy:

```sh
cd <fork>/packages/collab-web
bun build ./index.html --outdir=<tmp>/hub/dist/webui/collab --minify --define 'process.env.NODE_ENV="production"' '--entry-naming=[hash].[ext]' '--chunk-naming=[hash].[ext]' '--asset-naming=[hash].[ext]'
mv <tmp>/hub/dist/webui/collab/*.html <tmp>/hub/dist/webui/collab/index.html && cp -R public/. <tmp>/hub/dist/webui/collab/
```

Hub, from the temp copy after `bun install` in `hub` and `extension` and `bun run scripts/build-webui.ts`:

```sh
HOME=<tmp>/home OMP_HUB_STATE_DIR=<tmp>/hubstate OMP_HUB_HOST=127.0.0.1 OMP_HUB_PORT=48160 OMP_HUB_RELAY_PORT=47466 OMP_HUB_HOST_TOKEN=demo-token OMP_HUB_RELAY_ALLOWED_ORIGINS=http://127.0.0.1:48160 bun run src/server/index.ts
```

Two additions to the assigned command, both needed for isolation. `OMP_HUB_STATE_DIR` was added because the hub state directory defaults to `~/.local/state/omp-hub`, which is the live hub's state. `HOME` was set so that nothing is written under the real home.

Host sessions, launched in `tmux -L <unique socket>` by a small wrapper script:

```sh
HOME=<tmp>/home OMP_HUB_URL=http://127.0.0.1:48160 OMP_HUB_HOST_TOKEN=demo-token OMPC_SESSION=smoke \
  bun <fork>/packages/coding-agent/src/cli.ts -e <tmp>/omp-connected/extension/src/index.ts --model anthropic/claude-haiku-5-5
```

The temp `HOME` has its own `config.yml` (`collab.relayUrl: ws://127.0.0.1:47466`, `collab.webUrl: http://127.0.0.1:48160/collab/`, `collab.autoStart: control`) and a copy of the auth database, so the user's own config and live relay were not used. The Collab host registry lives under the home directory; the variant sessions below share the main temp home's registry through a symlink so that one hub lists them all.

Variant host sessions used for the failure and unsupported cases:

- `nosess`: fork omp with `--no-session` (unpersisted parent).
- `view`: fork omp with `collab.autoStart: view`.
- `old`: the globally installed omp 18.10.3 (no side request support), with the same extension.

Browser scripts used Playwright from the temp copy. Screenshots are under `/tmp/side-smoke/shots` and are not committed.

## Results

| # | Scenario | Result | Observed |
|---|---|---|---|
| 1 | Control link, desktop: hold Send while the parent runs a long task, pick Side request, Start | Pass | The parent was running three 20 second `sleep` tool calls. A 700 ms mouse hold opened the popover with `In`, `At`, `When idle`, `Side request`. Picking Side request showed: "Starts an independent subagent from the current conversation. It shares the workspace with this session, so their edits can conflict." and the button changed to `Start` |
| 2 | Draft handling on Start | Pass | The draft stayed in the box until the host answered: 42 ms after the click it was still there, 162 ms after the click the box and popover were gone, and 47 ms after that the new agent row was in the page. The 40 ms polling is too coarse to say more about ordering. The failure case (row 5) shows the draft kept when startup fails |
| 3 | The child in the guest agent panel | Pass | A subagent row "Side request: <first words of the text>" with the `sub` chip appeared and its transcript panel opened. Its tool call and output streamed ("side-ok"). The row's status went from running to idle. After it finished, rows for older children showed `parked` |
| 4 | Follow-up to the child while the parent is busy | Pass | A follow-up typed in the child panel was answered by the same child ("side-ok FOLLOWUP"). The parent's Stop button was still present, and its session file contains no side request text and finished its own task ("done") |
| 5 | Mobile touch viewport, same flow as 1 to 4 | Pass | A 700 ms touch hold opened the same popover; Start, child row, streamed output and follow-up answer all matched desktop |
| 6 | Pending host question (ask tool), desktop and mobile | Pass | While the question was pending the normal composer and Send button were absent (the question form replaced them), `window.ompCollabGuest.sideRequests` was `false`, and a draft typed before the question was back in the box after the question was answered, with side requests offered again |
| 7 | Failure path: unpersisted parent, desktop and mobile | Pass | Start showed the inline error "Side requests need a persisted session"; the popover stayed open, Start stayed enabled for a retry and the draft was kept. The host still advertises the capability for an unpersisted session, so the failure shows only after Start |
| 8 | Concurrent submissions | Pass | Two `submitSideRequest()` calls in one tick: one resolved with an agent id, the other was rejected with "A side request is already being started". One child was created and the draft was cleared |
| 9 | Host process killed while the popover was open | Pass | About 5 s after the kill the guest reported `sideRequests: false`; the popover preview changed to "Side requests are unavailable right now: the session may be read-only, reconnecting or waiting for an answer.", Start was disabled and the draft was kept |
| 10 | Read-only link | Pass | The dashboard opens a view-only session in its own read-only viewer: no Collab frame and no text box. The standalone guest opened with a view link had a disabled composer ("Read-only session, watching only") and `sideRequests: false` |
| 11 | Older host (omp 18.10.3) with scheduling available | Pass | `sideRequests` was `false`. A held Send opened the existing popover with `In`, `At`, `When idle` only; no Side request. Desktop and mobile |
| 12 | Older host without scheduling, held Send | Pass, simulated | No older host that lacks scheduling was available, so the browser rewrote the session list response to drop `session.schedule.v1` for that session. No popover opened on a 900 ms hold and the draft was sent as a plain message (desktop mouse, mobile touch) |
| 13 | Attachments blocking Start | Not covered | The guest built from this tree has no image attach UI (no paste or file input code in `packages/collab-web/src` apart from showing images in the transcript), so no attachment could be added. The popover code path for images was therefore not exercised |

Notes on method: the first hold attempts on mobile failed because a "guest joined" toast sat over the Send button and received the touch (see bug 3). Later scripts waited for toasts to clear.

## Provider cache check

Source: the parent and child session files of the main smoke session. All requests were `anthropic` / `claude-haiku-5-5`. Numbers are the `usage` fields of the first assistant request in each file after the child was created, as the provider reported them. Nothing here is inferred.

| Child | Fork time (UTC) | Parent last request before fork: input / cacheRead / cacheWrite | Child first request: input / cacheRead / cacheWrite |
|---|---|---|---|
| 1 | 12:23:35 | 4 / 17008 / 109 | 4 / 17117 / 235 |
| 2 | 12:25:13 | 4 / 17368 / 115 | 4 / 17483 / 235 |
| 3 | 12:27:20 | 4 / 17816 / 115 | 4 / 17931 / 235 |
| 4 | 12:35:54 | 2 / 18969 / 235 | 4 / 19209 / 227 |

- Children 1 to 3 were forked while the parent was in the middle of a turn. The parent's request listed is the first request of that turn, sent 4 to 5 seconds before the fork. For each, the child's cacheRead equals that parent request's cacheRead plus cacheWrite (17008+109, 17368+115, 17816+115).
- Child 4 was forked while the parent was idle, 7 minutes after its last request. The child's cacheRead (19209) is 5 higher than that request's cacheRead plus cacheWrite (19204).
- The usage records carry a cache write TTL of `ephemeral1h` on every request.
- The child session header records `providerPromptCacheKey` equal to the parent's session id for all four children.
- This is one model, one run and small prompts of about 17 to 19 thousand tokens. A provider-reported cacheRead is evidence for these requests only.

## Bugs and observations

1. A child can run the parent's unfinished task. Children snapshot the conversation while the parent is mid-turn, so the child's history ends with the parent's unanswered user prompt. The child notice says "NEVER continue, finish or answer anything the parent session left open above", yet in one of four children (the second one) the model issued the parent's pending `sleep 20 && echo one` call together with its own task and then ran the remaining two sleeps and answered "done". Repro: parent runs "three bash calls with sleep 20, then say done"; 3 seconds in, start a side request "run `echo side-ok` and reply with the output only"; read the child's transcript. Children 1, 3 and 4 behaved correctly. Model and thinking level were the cheapest ones, so this is not proof for stronger models. It is the shared workspace risk made concrete: the side effect was repeated sleeps, a real task could repeat edits.
2. The guest Agents rail opens on its own at page load when subagents exist. At the 1440 wide dashboard layout the guest frame is about 720 px wide and the rail covers the right part of the composer, including Send, so a click on Send is intercepted until the rail is closed with `hide agents`. Not checked whether this is existing guest behavior or new with this branch.
3. The "guest joined the collab session" toast sits over the Send button for a few seconds after load on mobile. A hold started there lands on the toast, so no popover opens (pointerdown target `sh-toast-msg`). Not checked against the base guest.
4. Mobile child panel header: right after Start the panel header showed the status chips and `kill` but no title; once finished the title was shown truncated as "Side re...". The only visible identification of the child on a phone is a truncated label.
5. The host advertises side request support for an unpersisted session, so the mode is offered and fails only after Start (row 7). The error is clear and the draft is kept, so this is low severity.
6. Not related to side requests: the Agents rail shows the main agent as `running` while idle (seen with the main session and with the omp 18.10.3 host that has no children). The hub reported `busy: false` for the same sessions.

No bug was found in the draft handling, capability gating, pending question handling, read-only handling or follow-up routing.

## Cleanup

Only processes started for this run were stopped: the hub (by PID), the host omp sessions (by killing the temp tmux server created with a unique socket name) and the browser scripts. Copies of the auth database in the temp homes were deleted. Session files, screenshots and scripts remain under `/tmp/side-smoke`.
