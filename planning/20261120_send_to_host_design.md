# Send an OMP session to another host

Written: 2026-11-20. Source revision: `4325f99ddb7631f932f7d1ca2f4ef9ad8ff9a54f` of omp-connected. Inspected OMP fork revision: `fb352288873a1268ec829407a2dddc3caac0e22d`. Status: implemented; the interfaces as built are in [the implementation contracts](20261121_send_to_host_contracts.md).

## Outcome

Add **Send to host** to a session's dashboard actions and a proposed `ompc send-to-host` command using the same worker. Continue the same conversation UUID on another configured host, at the same home-relative project path. Preserve the conversation title and launcher name where possible; report the actual label if a collision requires a suffix.

Transfer the selected conversation, its persisted nested subagent transcripts, artifacts and referenced image blobs. Do not transfer every session for the project. Retain the source files for recovery, but stop source execution before destination resume. Processes, live subagents, tool sessions, terminal state, credentials and hardware connections do not move.

If the destination project exists, require a confirmation box with **Update project with rsync**, **Leave project untouched; transfer session only**, and **Cancel**. Default to session-only. Show resolved paths and a change preview before confirming an update. Cancellation before commit leaves project and session data unchanged.

## What already exists

OMP has session transfer primitives. Reuse them rather than implement another journal copier or folder encoder.

All `src/session/...`, `src/commands/...` and `src/main.ts` references below are relative to `packages/coding-agent/` in the inspected OMP fork, rather than this repository.

| Source behaviour | Design consequence | Evidence |
|---|---|---|
| `omp session pack`, `unpack` and `moved` wrap archive and move-marker functions. | Build orchestration around the existing format and runtime code. | `src/commands/session.ts:19-24,123-137`; `src/session/session-transfer.ts:3-14` |
| Pack contains the main journal, recursive sibling artifact directory and referenced content-addressed blobs, including references in child journals. | Copying only JSONL loses artifacts and images. Nested children are already part of the archive. | `src/session/session-transfer.ts:272-335` |
| Pack refuses a live owner and holds a native ownership lease while reading. | Stop the source before packing. An idle flag or extension-only worker cannot bypass ownership safely. | `src/session/session-transfer.ts:211-224,267-285` |
| Unpack validates archive layout/blob hashes, computes the destination bucket, relocates the header cwd and records arrival. | Do not rename buckets by substituting usernames. | `src/session/session-transfer.ts:563-645` |
| Unpack replaces prefix histories and automatically forks divergent histories. | Add a strict same-UUID conflict policy for send-to-host; its default divergence behaviour does not meet this feature's contract. | `src/session/session-transfer.ts:603-633` |
| A departed marker makes normal CLI resume continue as a new, visibly marked fork. | Reuse moved markers after handoff. Add an in-progress reservation guard for the interval before that marker. | `src/session/session-transfer.ts:647-693`; `src/main.ts:1346-1389,2324-2328` |
| Bucket naming canonicalises cwd; home-relative paths use relative encoding, paths outside home use an absolute-path encoding. | Different usernames do not always imply different buckets. Ask the destination runtime for its path. | `src/session/session-paths.ts:54-115,222-224` |
| Opening a journal prefers its recorded cwd when accessible. | Launching from another directory alone is insufficient; use runtime relocation. | `src/session/session-manager.ts:4527-4563` |

Pack reports missing blobs but still writes an archive. The new feature must expose missing assets before final confirmation, and require explicit acceptance of an incomplete archive rather than silently report a complete transfer. Artifact symlinks are skipped by the current packer. Referenced external sessions and path-bearing child metadata need the portability audit below; archive inclusion alone does not establish that every historical link resolves.

### omp-connected integration points

- `extension/src/host-sessions.ts:97-113,231-266` lists UUID-based history, checks local ownership, reserves starts and launches detached `ompc` with an exact journal path. Reuse its launch checks and remembered name handling. The hub identity and Collab instance ID change on the destination; the conversation UUID stays the same.
- `hub/src/webui/app.ts:773-820` supplies the session action menu and capability/access gating. `hub/src/webui/lib/session-launcher.ts:139-176,283-355` supplies modal launch/request patterns.
- `hub/ARCHITECTURE.md:176-192` describes host RPC through an existing connected extension and its 30-second deadline. These calls are control requests, not a long-running transfer channel.
- `hub/ARCHITECTURE.md:104-128` confines `files.*` to the project root. Keep that boundary; do not use it to expose session storage or home directories.
- `extension/ARCHITECTURE.md:22` stores launcher suffixes separately from journals. Carry the selected suffix as explicit metadata, not by copying all local name records.
- `hub/ARCHITECTURE.md:244-273` keys custom groups by host and label/instance. Reassign the specific group member after successful handoff.

No SSH destination mapping, cross-host worker or atomic live-session transfer fence was found in the inspected extension. Existing runtime flush support does not fence subsequent input. Fork changes belong on a separate feature branch from upstream, not directly on an integration branch.

## User flow

1. Select **Send to host**. Require control access and advertised runtime/extension support. A busy session can be inspected, but commit stays blocked until it is idle. Do not abort it automatically.
2. Pick a locally configured destination. Show source and destination project paths, UUID, title, launcher name, nested-history count, sizes, missing assets, runtime compatibility and model availability. Do not copy provider credentials.
3. Map a project below source home to the same relative path below destination home, using canonical path components. A project outside home requires an explicit destination path permitted by local target policy.
4. Inspect the destination. If absent, offer project creation. If present, require the update/session-only choice. Show additions, replacements, mode changes, retained destination-only files, dirty/divergent Git state and known users of the tree. Session-only requires an existing usable directory and clearly leaves code/dependencies unchanged.
5. Confirm a plan bound to source UUID/head, target identity/path, project mode, preview digests and archive completeness decision. Recheck those facts before writes. Changed facts invalidate confirmation rather than silently widen it.
6. Show progress after commit, including the source downtime. On success select the destination session and retain its custom group. On failure show the precise state and safe recovery choices.

The UI may list configured SSH targets even without a connected destination extension. Preflight then uses the installed remote helper; success still requires destination OMP to register. Existing `/api/hosts` discovery alone cannot list or bootstrap an offline host. This feature does not install OMP, keys or credentials remotely.

## Transfer engine and trust boundary

Run a detached local worker outside the source OMP process. It owns SSH/rsync, the operation journal and recovery after the source exits. Both the command and dashboard use it. Project and archive bytes go directly over SSH; the hub carries control/status only.

Configure explicit mappings from allowed dashboard host IDs to SSH targets on the source. Do not treat a self-attested `hostId` as an SSH destination. Use batch SSH authentication, existing host-key verification and a fixed installed remote helper. Disable neither host-key checks nor authentication. Do not enable agent forwarding. Pass structured data and argument arrays; quote any unavoidable fixed remote command boundary without interpolating user values into shell syntax.

Resolve and validate all destination ancestors at commit. Project roots must be allowed by target policy and outside protected credential, session-store and omp-connected state directories. Reject home itself, filesystem root and symlink escapes. The project copy is trusted executable input: OMP can load its configuration/extensions, and Git metadata can affect later commands. Confirming transfer accepts that project on the destination.

The current hub has no dashboard-user authentication and uses a shared registration secret with self-attested host identities (`hub/ARCHITECTURE.md:342-364`). This feature inherits the trusted-dashboard-network model. Anyone with that control access can initiate an enabled transfer; the dialog does not authenticate a person. Default transfer support off until destinations are configured. Operation secrets prevent unrelated operation reuse, but do not establish per-user isolation. Any deployment needing untrusted dashboard users must add dashboard authentication before enabling this feature.

The worker opens a dedicated authenticated operation connection to the hub, independent of session registration. The hub issues a short-lived, operation-scoped credential after a control-authorised prepare request. That credential allows only the named operation's progress and constrained recovery commands, not arbitrary agent registration or shell work. Prepare also provisions a private operation-scoped renewal secret, persisted on the source and as a verifier in durable hub operation state. It can renew expired worker credentials without a connected source extension until the operation is completed or rolled back; finalisation revokes it. A restarted worker uses that secret, an explicit recovery command and a single-worker lock. It must recover after both credential expiry and hub restart.

Bind the SSH peer to the configured host mapping during helper preflight. Use a fresh launch nonce stored by the target helper and supplied to the destination extension; cross-check its UUID, cwd and process against the SSH helper before accepting a matching hub registration. A claimed host ID alone does not prove arrival. This adds no independent fleet-wide host authentication.

## Ownership and commit protocol

Keep private durable operation records on both hosts, keyed by operation ID. Reserve the **source UUID** across all operations, not just repeated requests with one ID. Reserve destination UUID, update path and launch label. Native resume/claim paths must honour an in-progress transfer reservation; a private file checked only by this worker is insufficient. Extend OMP's ownership boundary for this purpose and revalidate all CLI, SDK and in-process resume paths during implementation.

Use these recorded states: `prepared`, `source-stopping`, `source-stopped`, `staged`, `publishing`, `source-departed`, `destination-starting`, `completed`, `aborting`, `rolled-back`; failures retain the last confirmed state and an error. A worker restart reconciles actual leases/processes/files before advancing. Record launch intent before spawning and look up its nonce before any retry. Target cancellation serialises with launch under the same operation lock. A durable cancelled launch intent rejects delayed requests permanently; an already consumed intent requires owner reconciliation.

1. **Prepare.** Check installed transfer protocol/runtime versions, tools, free space, permissions, target credentials/model access and project conflicts. Preflight is read-only apart from private inspection/staging metadata. Reject a different existing destination history for this UUID under the strict policy below.
2. **Reserve and stop source.** Acquire reservations on both hosts. Recheck idle state and known child/background/hardware work. Pending prompts, asks and scheduled prompts block commit until the user resolves them. Fence new input and mutation during graceful shutdown, flush and wait for confirmed process exit/lease release. This small runtime handoff boundary is required; current idle/abort APIs are insufficient.
3. **Pack and stage.** Now the source is closed, use `packSession` under native ownership checks. Transfer its archive and requested project data into private destination staging. Verify digests and required asset completeness. Hold the transfer reservation even when pack releases its short-lived native lease. No ordinary resume can consume staged data.
4. **Publish project and session.** Recheck the accepted project preview and destination path. Publish a new tree by same-filesystem rename. Update an existing tree under its reservation with an undo manifest. Import with strict UUID/conflict semantics, using the runtime's relocation/artifact/blob handling. Keep destination resume blocked throughout publication.
5. **Mark source departed.** Append the existing durable `departed` marker after successful import and before any destination launch. Verify it. Retained source copies subsequently follow OMP's existing visible fork-on-resume behaviour, with a new UUID. Do not create a second same-UUID owner.
6. **Launch destination.** Atomically hand its reservation to the one launch carrying the operation nonce. Resume the exact imported file with the shared detached launcher. Verify expected UUID, cwd and SSH-bound registration. A successful spawn is not completion.
7. **Complete.** Record completion on both sides, release operation reservations, then reassign the dashboard group/selection. Keep source files, departure marker and recovery metadata. Do not forward messages addressed to the old agent automatically.

Stage the archive rather than publish it before source shutdown. Reserve native destination resume before import; do not rely on a launcher's 60-second pending-name record as a cross-host lock. Reservations left by a dead worker remain blocked until reconciled, rather than expiring into an unsafe resume.

### Strict import and source recovery

Reuse archive version 1 and validation, but add a strict unpack option that refuses divergent same-UUID copies before publishing or changing them. Default `unpackSession` can fork on divergence; send-to-host must never silently change identity. Check all destination buckets. Permit an identical archive replay by this operation, recognising its already appended arrival marker rather than importing twice. Replacing an earlier prefix requires a separately confirmed preview under the native ownership reservation. Strengthen the existing entry-ID-only prefix comparison with content checks while retaining its explicit exception for local-only departed markers (`src/session/session-transfer.ts:449-460`). That exception permits a completed reverse transfer back to the retained source.

After a completed handoff, ordinary source resume may create a visibly marked new fork under existing OMP behaviour. Returning the same UUID to source is a reverse transfer of the destination's current history. To recover a failed handoff to source, first durably cancel the target launch intent under its operation lock, confirm no destination owner, and reconcile any published arrival/departure markers. Then record rollback and release the source guard. Observing no owner without revoking delayed launch authority is insufficient. An unreachable target leaves source recovery blocked. Do not erase a completed departure marker to revive stale history.

| Failure point | Recovery |
|---|---|
| Before commit | Cancel without changing project/journals; remove operation-owned inspection data. |
| Source stopped, staging fails | Keep both reservations and retained source files. Offer retry or source resume only after confirming destination never started. |
| Project update/import fails | Block destination launch. Show affected entries and undo manifest. Restore explicitly as described below. |
| Import succeeded, departure recording fails | Keep destination blocked and reconcile source state. Do not launch. |
| Source departed, destination launch fails | Retain imported data. Retry the one destination launch, or perform checked rollback before resuming source. |
| Launch acknowledgement or network contact lost | Query the target helper's operation/nonce and actual ownership. Never automatically restart source or spawn another target. |

Cancel after commit requests a safe stop, not automatic rollback. Before publication it can remove staging and offer checked source recovery. Once publication starts, stop at a recorded boundary and require explicit recovery. Once destination starts, use a reverse transfer to return ownership. Closing the browser never cancels the worker.

## Project rsync policy

Copy hidden files, Git metadata and uncommitted/untracked work. Show an explicit exclusion list; do not silently use `.gitignore`. Preserve ordinary modes and internal symlinks without following them outside the tree. Do not recreate devices, sockets, host ownership or setuid bits. Do not scan or print secret values; warn that project-local secrets travel with selected files. Credentials outside the project are excluded.

Use rsync update semantics without `--delete`; retain destination-only entries. Refuse non-empty directory-to-file/symlink replacements, ancestor symlink traversal and other type conflicts that cannot preserve those entries. Require separate manual resolution and a new preview. Never hide destructive type changes inside a generic update confirmation.

Updating a project used by another known session is blocked. Unknown external writers remain an operator responsibility. Recheck content/type/mode digests before writes, not just mtimes; advisory locks cannot fence unrelated tools. External Git worktree gitdirs, submodules, absolute symlinks and external dependencies need explicit portability checks. Do not recursively copy an external directory just because a symlink points to it. Destination architecture may require environment/build regeneration.

The undo manifest records created entries, replaced contents/types, prior modes and the operation's resulting digests. Restore removes operation-created entries and restores replaced entries/modes only where current state still matches the operation's writes. Intervening edits cause a conflict for manual resolution, never overwrite. Retain backups and failed-operation locks until resolved. On success, release the lock and retain backups until explicit user cleanup; show their location and disk use.

## Session portability contract

Include the selected main journal and its sibling artifact tree recursively, plus referenced global blobs through the existing packer. Include persisted nested child journals, not running child processes. Standalone forks/sibling conversations are not automatically descendants to copy just because they share a project or `parentSession` field. Audit actual persisted references to identify any required linked history outside the artifact tree; include resolvable required dependencies or report exactly what cannot move before confirmation.

Preserve UUIDs, entry IDs, active branch, compaction records and transcript text. Use runtime-supported relocation for cwd and managed paths. Audit child header cwd, absolute parent references, `previousSessionFiles`, additional directories and artifact references. Convert only recognised structural path fields with a source-to-destination mapping. Never globally replace home paths in message/tool text. Test relocated child history through the actual history reader, not just by checking files exist.

No Python/JS eval kernel, active REPL, PTY, background service, pending ask, memory-only scheduled prompt or hardware connection can be reconstructed from a transcript. Preflight reports known live resources and requires their completion/release before stop. Missing assets and unresolved external paths require an explicit completeness decision; no silent fake replacement.

## Delivery slices

| Slice | Changes | Exit evidence |
|---|---|---|
| 1. Runtime transfer contract | Reuse pack/unpack/moved; add strict same-UUID import, in-progress resume/ownership reservation, shutdown input fence and supported nested-path relocation where needed. Fork branch from upstream; no direct integration-branch edits. | Two isolated homes, same UUID and active branch, nested history and images readable, divergent copies refused, no resume gap. |
| 2. Worker and command | New worker/helper and `ompc send-to-host` entry; configured SSH mapping, plan/digest preview, project modes, durable state, operation channel, reservations and recovery. | Actual SSH transfer across different home paths, project preservation/undo, worker restart and uncertain-ownership scenarios. |
| 3. Dashboard and hub | Explicit transfer capabilities, prepare/commit/status/cancel/recover routes; operation-scoped worker channel; conflict modal, progress and group/selection handoff. | Browser interaction with both project choices, no connected source extension after stop, successful verified destination selection. |
| 4. Cross-host acceptance and documentation | Exercise supported runtimes and plain OMP/ompc resume paths. Update README, both architecture documents and configuration examples using placeholders. | End-to-end acceptance cases below; unsupported runtime stays visibly unsupported. |

Slices 2 and 3 can progress against the agreed runtime/worker contract; end-to-end acceptance depends on all three. Before implementation, revalidate source anchors and whether upstream already supplies any proposed runtime changes. Advertise transfer capability only when the required APIs and helpers are present, not by version-string guess alone.

## Acceptance cases

- Same UUID, title, active branch and nested child history survive different home paths. Referenced images/artifacts load. Launcher suffix is preserved or an explicit collision suffix is reported. No unrelated project conversations travel.
- Session-only leaves destination project bytes/types/modes unchanged. Update applies only confirmed entries, retains destination-only files and records undo data. Type conflicts block safely.
- Pending prompts, asks, active children, known hardware/background work, destination owner and known destination project users block without silently discarding work.
- Two distinct operations for the same source UUID cannot both proceed, including different destinations. Ordinary CLI/SDK resumes on either side cannot bypass in-progress reservations. After completion, source resume visibly forks to a different UUID.
- Duplicate commits, browser/hub disconnect, helper restart and worker crashes immediately before/after source release and destination spawn do not create duplicate owners. Reconcile launch intent by nonce. Race a delayed destination launch against source recovery and prove the cancelled intent cannot start.
- Progress/recovery work after worker credential expiry and hub restart with no source extension connected. Finalised operation credentials cannot renew. Cancel before commit, during staging, during publication and after launch follows the stated boundaries.
- Replay the same operation after import and complete a transfer from A to B and back to A. Keep one arrival per operation, preserve the UUID and apply the departed-marker prefix exception without accepting changed message contents.
- Undo handles created entries, content, types and modes, and refuses to overwrite intervening edits.
- Reject injection, path traversal, protected roots, symlink escape, stale preview, unsupported runtime, insufficient space and divergent UUID copies before unsafe writes. Refuse mismatched operation credentials and spoofed destination arrival.
- Missing blobs, skipped artifact symlinks and unresolved external history/path dependencies are visible before committing to incomplete transfer.
- Run the real CLI/SSH scenario and dashboard flow on isolated test hosts. No live deployment details or private transcripts belong in committed fixtures.

## Review and verification record

The design was checked against repository architecture, host-session launch code and the fork's existing session-transfer implementation. Independent design review identified source reservation, stale-source resume, import visibility, type-conflict/undo, cancellation, caller trust and post-shutdown control gaps; those contracts are included above. The specialist reviewer was unavailable due to a rate limit; a separate general agent performed the review. The feature is implemented; unit and fake-ssh tests pass. No fleet deployment, live two-host run or hardware operation has been done.
