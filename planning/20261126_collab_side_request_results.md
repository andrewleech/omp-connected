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

### Re-run after framing fix

Date: 2026-11-27. Host process restarted from fork commit `f6ab89bfd8`, which makes the child's first user message begin with a `<system-notice cause="side-request">` block (conversation above belongs to the parent; do not answer, continue or repeat its open work) followed by the task text. `git log 3390b2b67d..HEAD` shows no `collab-web` change, so the guest bundle was not rebuilt. Same hub setup, same model (`claude-haiku-5-5`, thinking `low`), a fresh host home and session directory. Each trial: the parent gets "three separate bash `sleep 20` calls (echo one, two, three), then reply done" from the guest composer, then the side request "run `echo side-ok` and reply with the output only" is started. Trials 1 to 8 used the hold-Send popover (Side request, Start). Trials 9 to 11 called `window.ompCollabGuest.submitSideRequest()` right after clicking Send, because the popover hold needs 700 ms and the model answers within about a second.

| Trial | Start after parent prompt | Last entry of the child's copied history | Child did only the side task | Parent finished unaffected |
|---|---|---|---|---|
| 1 | 3.9 s | the parent's prompt (first tool call still running) | Yes: `echo side-ok`, answer "side-ok" | Yes: three sleeps, "done" |
| 2 | 25.9 s | result of the first sleep (mid-turn, partial batch) | Yes | Yes |
| 3 | 3.9 s | the parent's prompt | Yes | Yes |
| 4 | 25.9 s | result of the first sleep | Yes | Yes |
| 5 | 3.9 s | the parent's prompt | Yes | Yes |
| 6 | 25.9 s | result of the first sleep | Yes | Yes |
| 7 | 1.2 s | the parent's prompt, no assistant message yet | Yes | Parent answered "done" without tool calls (it noted the identical request had arrived several times; this is the parent model, not the side request) |
| 8 | 1.2 s | the parent's prompt, no assistant message yet | Yes | Yes: three sleeps, "done" |
| 9 | 0.16 s | the parent's prompt, no assistant message yet | Yes | Yes |
| 10 | 0.20 s | the parent's prompt, no assistant message yet | Yes | Yes |
| 11 | 0.19 s | the parent's prompt, no assistant message yet | Yes | Yes |

Result: 11 of 11 children made exactly one tool call (`echo side-ok`) and one final answer "side-ok", with no sleep call and no reply to the parent's prompt. In the previous run 1 of 4 children repeated the parent's sleeps. Trials 7 to 11 are the case where the trailing parent entry is an unanswered user prompt with no tool round yet; trials 1, 3 and 5 are the same shape with the parent's first tool call still running; trials 2, 4 and 6 are a partial tool batch. Parent prompts for trials 9 to 11 used different echo words to avoid the parent's repeated-request answer seen in trial 7. This is one model at the cheapest setting and one task; it shows no failure in 11 trials, not that failure cannot happen.

One further child, started from the mobile viewport with the popover, also did only the side task (one `echo side-ok` call) and answered a follow-up correctly while the parent finished its own task.

Bug 4 (mobile child panel header) re-checked with the mobile viewport on this head: still present. While the child is running the panel header shows the `running` chip, the model chip and `kill`, with no title text visible.

New observation from the re-run: the notice block is now part of the child's first user message, so the child's transcript shows the raw `<system-notice cause="side-request">...</system-notice>` text above the task text in the first user bubble (visible in the mobile screenshot). Not a functional problem; it is what the user sees in the subagent panel.

## Fleet build smoke (v19.1.1)

Date: 2026-11-27. Local only, same isolation as the earlier runs (hub on `127.0.0.1` demo ports, temp `HOME`, temp `OMP_HUB_STATE_DIR`, temp `TMUX_TMPDIR`; auth copy deleted afterwards).

Environment:

- Host: the fleet binary `dist/omp` of the `fleet-v19.1.1-side-request-final` worktree (`omp/19.1.1`), started with `ompc -d` and `OMP_BIN` set to that binary, so the tmux wrapper and the real `extension/` from the omp-connected checkout were used. The extension was linked into the temp home with `omp plugin link <repo>/extension`. `ompc` read its hub settings from a temp `OMP_HOST_ENV` file.
- Guest: the fleet guest bundle (`node_modules/.collab-guest.*` of that worktree) copied to `dist/webui/collab` of a temp copy of `hub/`; the live `hub/dist` was not touched.
- Dashboard: the `hub/` working tree at the time of the run (including another session's uncommitted edits), copied without `node_modules`, `dist` and `vendor`, then `bun install` and `bun run scripts/build-webui.ts` in the copy.
- Model: anthropic `claude-haiku-5-5`, thinking `low`. Browser: Playwright 1.63 headless Chromium; desktop 1440x900 and "iPhone 13" touch.
- Screenshots: `/tmp/side-smoke/fleet/shots` (not committed).

| # | Check | Result | Observed |
|---|---|---|---|
| 1 | Extension loads, host registers, dashboard lists the session | Pass | The hub's agent list showed the session with its `ompc` label and the extension's feature list (`session.schedule.v1` and others, including `session.model_roles.v1` and `session.agent_roles.v1`). The dashboard listed the session and opened it in control mode. The session log had no error-level entries; the only warnings were model discovery probes of local providers that were not running |
| 2a | Hold-Send menu on the fleet guest | Pass | `window.ompCollabGuest` had `sideRequests: true` and `submitSideRequest`. A 700 ms hold showed `In`, `At`, `When idle`, `Side request`; the Side request preview showed the shared workspace warning |
| 2b | Side request while the parent runs three `sleep 20` calls, 3 s offset (popover) | Pass | The child appeared in the guest drawer, called `echo side-ok` once; a follow-up reached the same child and was answered; the parent finished "done" |
| 2c | Same, 25 s offset (popover) | Pass | The child called `echo side-ok` once and answered the follow-up; the parent finished "done" |
| 2d | Same, via `window.ompCollabGuest.submitSideRequest()` 0.3 s after the parent prompt | Fail | The child's first tool call was the parent's pending `sleep 20 && echo <word>`; it then ran the parent's remaining sleeps as well as `echo side-ok` and ended with "side-ok done". The parent also finished "done". See F1 |
| 2e | Extra children of the same shape (0.1 s and 3 s offsets, via `submitSideRequest()`) | Pass, 9 of 9 | Each child made one `echo side-ok` call and answered "side-ok". The parent turn was stopped by the script about 10 s after each start, so parent completion is not reported for these. A tenth start was refused with "Too many side request subagents are running (limit 8)", so the subagent cap works |
| 3 | Draft and history after Start; normal send | Pass | The draft was still in the box 40 ms after the Start click, and empty with the popover gone 160 to 200 ms after it; the child drawer opened 240 ms after. After closing the drawer, ArrowUp recalled the parent's last prompt, a second ArrowUp the one before it, and ArrowDown past the newest restored the empty draft. A normal prompt sent while the parent was running was accepted as a normal queued message: the host sent the running bash command to the background to handle it, answered it, then the parent continued and finished "done". The side request text was not added to history |
| 4 | Image chip blocks Start | Pass | One chip after attaching an image. In Side request mode Start was disabled with "Images can't be sent with a side request. Remove them first." A forced click on the disabled button created no child and kept the chip and the draft. After Cancel, a normal send with the image worked: the chip cleared and the parent answered |
| 5 | Mobile touch viewport, hold Send | Pass | A 700 ms touch hold opened the same popover; Side request, Start, empty draft, child drawer with its output streaming. The notice text shows in the first bubble. Bug 4 (no title in the child header while running) is also present in the fleet guest |
| 6 | Existing older session in the fleet guest | Pass | The earlier session was resumed with `ompc -d --continue`. The guest loaded its full transcript (about 30 collapsed items, scrolled to the top), showed the 13-child badge on the agents toggle, offered `sideRequests: true`, and logged no page errors |

Bugs and observations from this run:

- F1. The child can still run the parent's open work on the fleet build. In the main session 1 of 12 children did (child 3, started 0.3 s after the parent prompt); of the 8 children started in the "parent prompt sent less than a second ago, no assistant message yet" shape, 1 did and 7 did not. The notice text is the same as on the upstream-19.2 branch re-run, where 11 of 11 children were clean. Repro: parent gets "three bash `sleep 20` calls, then done"; call `window.ompCollabGuest.submitSideRequest()` 0.1 to 0.3 s later with "run `echo side-ok` and reply with the output only"; read the child's transcript. This is a small sample at the cheapest model; it shows the framing is not a guarantee.
- F2. In my script a follow-up sent within about 0.3 s of Start interrupted the child's running `echo` (the host's "Backgrounded early to handle an incoming message" behaviour) and the child first answered that it had no output yet. This is a test timing effect and the host's normal message handling, not a side request defect.
- F3. The `hub/` working tree used for the dashboard includes an uncommitted collab-name feature: a "Your name" dialog blocks the guest until a name is saved (or `omp.collab.name` is set in local storage). The scripts set it. Not a side request issue; reported as requested.
- F4. After a fresh page load, ArrowUp recalled only the two most recent prompts that were checked, not every earlier prompt of the session. I did not check whether that is the guest's intended window.

Cleanup for this run: the hub (by PID), both tmux servers (by their temp `TMUX_TMPDIR`) and one omp daemon worker started under the temp home were stopped; the auth copy was deleted. Session files, screenshots and scripts remain under `/tmp/side-smoke/fleet`.

## Cleanup

Only processes started for this run were stopped: the hub (by PID), the host omp sessions (by killing the temp tmux server created with a unique socket name) and the browser scripts. Copies of the auth database in the temp homes were deleted (again after the re-run, which also stopped its own hub, host sessions and daemon worker by PID). Session files, screenshots and scripts remain under `/tmp/side-smoke`.

## Automated checks

Fork branch `collab-side-request` at head `git log -1` after commit "test(collab): expect the framed side request task in the guest client test", off upstream/main `d9a63f498b`. Bun 1.4.4 on PATH (the CLI needs 1.4.4 or newer; with Bun 1.4.2 the registry smoke, session lease probe and bash fd-inheritance tests fail for that reason and pass on 1.4.4).

| Command | Result |
|---|---|
| `bun test packages/coding-agent/test/task packages/coding-agent/test/collab packages/coding-agent/test/session packages/coding-agent/test/session-storage-fd-inheritance.test.ts` (fork worktree) | 2211 pass, 0 fail |
| `bun test` in `packages/collab-web` | 172 pass, 0 fail |
| `tsc --noEmit` for `packages/wire`, `packages/collab-web`, `packages/coding-agent` | no errors in these packages |
| `oxlint` and `oxfmt --check` on the changed `.ts` and `.tsx` files | clean |
| `bun test tests/webui` in `hub` (omp-connected) | 185 pass, 0 fail |
| `bunx playwright test tests/e2e/scheduled-send.spec.ts --repeat-each=4 --retries=0` in `hub` | 52 pass, 0 fail (one earlier single run had a flaky first attempt while the smoke environment was loading the machine) |

Review rounds: standard review, adversarial review and a re-review of the fixes. Findings fixed: child approval mode inherited from the parent instead of forced to yolo (live and after revive), first prompt runs no slash or extension commands, revived child reports nothing to the parent, parent artifact manager adopted, task depth consistent live and revived, cap of 8 live children (parked children count again once revived), 120 second start timeout, internal error text hidden from guests, one side request in flight per peer, text, image count and image size limits, image field whitelist, framed first message so a mid-turn snapshot is not mistaken for the child's own work.

## Open items

- Image attachments: the upstream guest composer has no attach UI, so the embed API sends text only and the popover disables Start while attachment chips exist. The fleet guest has image attach; when this branch is merged into the integration the embed must read the composer attachments (a follow-up in the integration merge).
- The upstream 19.2.x base is not the deployed fleet base. The branch is not yet merged into `ompc-fleet`; add a `[[submodules.branches]]` entry and refresh through mbm when it is wanted in the fleet build. Not deployed.
- Mobile child panel header shows no title while the child runs (bug 4), the agents rail covering Send at some dashboard widths (bug 2) and the join toast covering Send on mobile (bug 3) were not checked against the base guest; none is specific to the side request code.
- The child's first message shows the framing notice as raw text above the task in the subagent panel (cosmetic).
- The host advertises side requests for an unpersisted session; Start then reports "Side requests need a persisted session" and keeps the draft.
