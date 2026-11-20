# Send-to-host implementation contracts

Written: 2026-11-21. Source revision: `9020e60`. Implements [the design](20261120_send_to_host_design.md). These are the interfaces shared by independent work packages. Change one only by updating this file and every consumer.

## Components

| Name | Location | Role |
|---|---|---|
| OMP runtime | fork worktree `wt/send-to-host`, branch `session-send-to-host`, path `packages/coding-agent/` | `omp session` CLI, strict import, transfer reservations |
| Journal and config | `extension/src/transfer/journal.ts`, `config.ts` | durable operation records, state machine, locks, launch intent, destination config |
| Project sync | `extension/src/transfer/project-sync.ts` | manifest, diff, path policy, apply, undo |
| Destination helper | `extension/src/transfer/helper.ts`, `extension/bin/ompc-transfer-helper` | stdin/stdout JSON protocol on the destination, reached over SSH |
| Source worker | `extension/src/transfer/worker.ts`, `ssh.ts`, `hub-client.ts`, `extension/bin/ompc-send` | detached orchestrator on the source |
| Extension RPC | `extension/src/transfer/rpc.ts`, wiring in `index.ts` | `session.transfer.v1` methods, input fence, arrival record |
| Hub | `hub/src/server/transfer-*.ts` | operation store, credentials, REST, worker API |
| Dashboard | `hub/src/webui/lib/transfer-*.ts`, `app.ts` | menu, plan view, conflict choice, progress |

All new code uses placeholders only: `hub-host`, `user`, `worker-host`, `/home/user`. Tests use temporary directories and fake hosts.

## OMP runtime contract (`packages/coding-agent/src/session/`)

`session-transfer.ts` additions:

```ts
export type SessionTransferErrorCode =
  | "diverged" | "prefix-replace-requires-confirmation" | "reserved" | "live-owner"
  | "invalid-archive" | "missing-input" | "other";
export class SessionTransferError extends Error { code: SessionTransferErrorCode }

interface UnpackSessionOptions { cwd; sessionDir?;
  strict?: boolean;              // default false keeps today's behaviour exactly
  operationId?: string;          // recorded on the arrival marker
  allowPrefixReplace?: boolean;  // strict only
}
type UnpackMode = "created" | "replaced" | "forked" | "replayed";
```

Strict import rules, evaluated before any blob or journal write, across every project bucket:
- A local copy whose body is not a content-equal prefix of the incoming body throws `diverged`. Content equality compares entry id and the canonical JSON of the entry after the normalisation the session loader applies. Transfer markers (`session-transfer` custom messages) present only locally are skipped, as today.
- A local copy whose body equals the incoming body plus an `arrived` marker with the same `operationId` returns `replayed` and changes nothing.
- A local strict prefix throws `prefix-replace-requires-confirmation` unless `allowPrefixReplace`.
- No local copy behaves as today (`created`).
Arrival and departure marker details gain optional `operationId`. `markSessionMoved(file, label, { operationId? })`.

`PackSessionResult` gains `children: number`, `bytes: number`, `skippedSymlinks: string[]`, `externalReferences: string[]` (absolute paths in header or child-header fields such as `parentSession`, `previousSessionFiles`, `additionalDirectories` that point outside the archived tree).

New module `transfer-reservation.ts`. A reservation is a file `<agentDir>/session-transfer/reservations/<sessionId>.json`:

```ts
interface TransferReservation { sessionId: string; operationId: string; role: "source" | "destination"; createdAt: string; note?: string }
reserveSession(sessionId, operationId, role): TransferReservation   // atomic create; same op+role is idempotent; any other holder throws code "reserved"
releaseSession(sessionId, operationId): boolean                      // only the holder releases
readReservation(sessionId): TransferReservation | undefined
assertNotReserved(sessionId, opts?: { operationId?: string }): void // throws code "reserved" unless the holder matches
```
Enforcement: every path that opens, resumes, continues, forks or claims an existing session by id or file, in CLI, SDK and in-process switch paths, calls `assertNotReserved` before writing. Pack, unpack, moved and reservation commands pass their own `operationId`. A reservation never expires by time.

Fork behaviour around the reservation file. Implicit auto-resume (no explicit session) falls back to a new session, with a warning on stderr, when the newest session is reserved. While a `source` reservation is held, the running process refuses prompts, steers, follow-ups, `/retry`, `restoreInterruptedTurn` (`--restore`), `pi.sendUserMessage`, user-attributed `pi.sendMessage` calls that start or queue a turn, custom prompts and Collab guest prompts with `session is being transferred (operation <id>)`. Agent-attributed input (IRC wakes, async job results, subagent returns) is exempt. Every check reads the reservation file, so a reservation made by another process takes effect at once. The turn in flight, queued messages and shutdown are unaffected.

CLI (`omp session ...`), all with `--json` that prints exactly one JSON object on stdout and diagnostics on stderr, exit code 0 on success and 2 on a `SessionTransferError` (the JSON object then is `{ "ok": false, "code": ..., "message": ... }`):
- `pack <session> -o <archive> [--operation <id>] --json` -> `{ ok, archivePath, id, missingBlobs, children, bytes, skippedSymlinks, externalReferences }`
- `unpack <archive> --cwd <dir> [--strict] [--allow-prefix-replace] [--operation <id>] --json` -> `{ ok, sessionFile, id, mode }`
- `moved <session> --label <text> [--operation <id>] --json` -> `{ ok }`
- `reserve <id> --operation <id> --role source|destination --json`, `release <id> --operation <id> --json`, `reservation <id> --json` -> `{ ok, reservation | null }`
- `locate <id> --cwd <dir> --json` -> `{ ok, sessionFile | null, sessionDir }` resolves the journal path for a session id in the cwd's session directory (all buckets).
- `fence-status <id> --json` -> `{ ok, fenced, operationId? }`; `lease --json -- <id>` -> `{ held, unknown }` (no `ok` field), the ids a live omp process owns or whose owner cannot be determined.

## Journal and state contract (`extension/src/transfer/journal.ts`)

```ts
export type TransferState = "prepared" | "source-stopping" | "source-stopped" | "staged" | "publishing"
  | "source-departed" | "destination-starting" | "completed" | "aborting" | "rolled-back";
export type TransferRole = "source" | "destination";
export interface LaunchIntent { nonce: string; status: "recorded" | "cancelled" | "consumed"; recordedAt: string; settledAt?: string }
export interface OperationRecord {
  operationId: string; role: TransferRole; sessionId: string; state: TransferState; lastConfirmedState: TransferState;
  planDigest: string; projectMode: "create" | "session-only" | "update"; destinationName?: string;
  sourceProject?: string; destinationProject?: string; sessionName?: string; error?: { code: string; message: string; at: string };
  launch?: LaunchIntent; history: { state: TransferState; at: string; detail?: string }[]; createdAt: string; updatedAt: string;
}
export class OperationJournal { constructor(dir: string)
  create(init): Promise<OperationRecord>; load(id): Promise<OperationRecord | undefined>; list(): Promise<OperationRecord[]>;
  transition(id, to, detail?): Promise<OperationRecord>;   // enforces the allowed-transition table, atomic write, fsync
  fail(id, error): Promise<OperationRecord>;               // keeps lastConfirmedState, records error
  withOperationLock<T>(id, fn): Promise<T>;                // exclusive across processes; stale holders detected by dead pid
  acquireWorkerLock(id): Promise<{ release(): Promise<void> }>; // single worker per operation
  recordLaunchIntent(id, nonce): Promise<void>; cancelLaunchIntent(id): Promise<"cancelled" | "already-consumed" | "none">;
  consumeLaunchIntent(id, nonce): Promise<boolean>;        // false when cancelled or nonce mismatch; serialised with cancel under the operation lock
}
```
Allowed forward transitions follow the design's sequence (`prepared` -> `source-stopping` -> `source-stopped` -> `staged` -> `publishing` -> `source-departed` -> `destination-starting` -> `completed`); `aborting` is reachable from every non-terminal state except `completed`; `rolled-back` only from `aborting`; `completed` and `rolled-back` are terminal. Journal directory: `${XDG_STATE_HOME:-~/.local/state}/omp-connected/transfers/`.


`config.ts` loads `${XDG_CONFIG_HOME:-~/.config}/omp-connected/transfer.json`:

```json
{ "enabled": false, "destinations": { "<name>": { "hostId": "user@worker-host", "ssh": { "target": "user@worker-host", "port": 22, "identityFile": "~/.ssh/id" },
  "helperPath": ".local/bin/ompc-transfer-helper", "allowedRoots": ["~"], "protectedPaths": ["~/.ssh", "~/.omp", "~/.config", "~/.local/state"] } } }
```
Transfer is off unless `enabled` is true. Destination names match `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`. `hostId` is only a dashboard label; it is never used as an ssh target.

## Project sync contract (`extension/src/transfer/project-sync.ts`)

```ts
export interface ManifestEntry { path: string /* posix, relative */; kind: "file" | "dir" | "symlink"; mode: number; size?: number; sha256?: string; target?: string }
export interface TreeManifest { root: string; entries: ManifestEntry[] /* sorted by path */; warnings: ProjectWarning[]; }
export type ProjectWarning = { kind: "external-symlink" | "absolute-symlink" | "external-gitdir" | "submodule" | "possible-secret-file" | "special-file-skipped"; path: string; detail?: string };
export const DEFAULT_EXCLUDES: string[];      // explicit, reviewed list (e.g. node_modules caches are NOT silently excluded unless listed here); never .gitignore-driven
buildManifest(root: string, opts?: { exclude?: string[] }): Promise<TreeManifest>
export interface PlanEntry { path: string; action: "add" | "replace" | "mode-change"; kind: ManifestEntry["kind"]; bytes: number }
export interface PlanConflict { path: string; sourceKind: ManifestEntry["kind"]; destinationKind: ManifestEntry["kind"]; reason: string }
export interface ProjectPlan { mode: "create" | "session-only" | "update"; entries: PlanEntry[]; unchanged: number; destinationOnly: number; conflicts: PlanConflict[]; totalBytes: number; warnings: ProjectWarning[]; digest: string }
diffManifests(source: TreeManifest, destination: TreeManifest | undefined, mode): ProjectPlan   // session-only -> empty entries; conflicts when a destination non-empty dir would be replaced by a file or symlink, or a file path sits under a destination symlink
resolveDestinationProject(sourceProject: string, sourceHome: string, destinationHome: string, override?: string): string
validateDestinationPath(candidate: string, policy: { home: string; allowedRoots: string[]; protectedPaths: string[] }): Promise<string>  // rejects home itself, filesystem root, protected paths and anything beneath or above them, ancestor symlinks that escape allowed roots
applyProjectUpdate(opts: { stagingDir: string; destRoot: string; plan: ProjectPlan; undoDir: string }): Promise<UndoManifest>  // re-verifies destination digests for every path it will touch, backs up replaced entries, never deletes destination-only entries, records created entries, prior modes and resulting digests
publishNewProject(stagingDir: string, destRoot: string): Promise<void>   // same-filesystem rename; fails if destRoot exists
restoreProjectUpdate(undoDir: string): Promise<{ restored: string[]; conflicts: string[] }>  // restores only where current state still equals the operation's own write; otherwise reports a conflict and never overwrites
```
The source file list for transfer goes to rsync via `--files-from` using `plan.entries` (add and replace). Symlinks are never followed outside the tree; devices, sockets and setuid bits are never created.

## Destination helper protocol (`ompc-transfer-helper`)

Invoked over SSH as one fixed command with no user-controlled arguments: the helper path from config. Request is one JSON object on stdin, response one JSON object on stdout, `{ ok: true, ... }` or `{ ok: false, code, message }`; exit code 0 for any well-formed reply. Request shape: `{ protocol: 1, op, operationId?, ... }`; `operationId` and `sessionId` use the journal id regexes and are validated before any filesystem access. All user data travels in the JSON, never in argv. The helper always enforces built-in protected paths (the same four defaults as config) in addition to any policy supplied in the request.

| op | request fields | response fields |
|---|---|---|
| `hello` | none | `home`, `hostname`, `user`, `hostId` (`user@hostname`), `ompBin`, `ompVersion`, `ompc` (path or null), `rsync` (bool), `freeBytes` (home filesystem), `transferProtocol` |
| `inspect` | `projectPath` (absolute, already mapped by the worker), `policy {allowedRoots, protectedPaths}`, `exclude[]`, `sessionId`, `operationId?` | `resolvedProject`, `exists`, `isDirectory`, `stagingSameFilesystem` (the helper journal directory and the project share a filesystem; a created or updated project is moved out of staging, so `false` blocks those modes), `manifest` (TreeManifest, when exists), `gitDirty` (bool or null), `knownUsers[]` (best effort, may be empty), `session {existsLocally, replayable, sessionFile, reservation}` (`replayable` is true only when `operationId` is given and that operation already imported this exact journal file) |
| `reserve` | `operationId`, `sessionId`, `planDigest`, `projectMode?`, `destinationProject?`, `policy?`, `destinationName?`, `sessionName?` | creates the destination journal record (`prepared`) or finds the matching one, and runs `omp session reserve --role destination`; a reserve that fails rolls back a record this call created (`aborting` -> `rolled-back`) -> `state`, `resumed`, `reservation` |
| `stage-dir` | `operationId` | `stagingRoot`, `archivePath`, `projectStaging`, `undoDir` (private 0700 directories under the journal directory); refused after `publishing` |
| `import-session` | `operationId`, `sessionId`, `cwd` (inside the operation's destination project), `allowPrefixReplace?` | needs the destination reservation held by the operation, moves the record to `publishing`, runs `omp session unpack <archivePath> --cwd <cwd> --strict --operation <op> --json` and records `import.json` (`sessionFile`, first-import `mode`, `cwd`, `artifactsDir`) -> `sessionFile`, `mode`, `state` |
| `publish-project` | `operationId`, `mode`, `destRoot`, `plan`, `policy`, `planDigest` | `create` renames `projectStaging` into place, `update` runs `applyProjectUpdate`, `session-only` requires an existing directory and writes nothing. `create` and `update` write `project-applying.json` before the change and `project-published.json` after it; a replay with the same mode and root answers `replayed: true`, and an applying marker whose change is complete (created tree equals the plan, or the undo manifest is `applied` for the same plan digest) is completed without repeating it. After `restore-project` the op answers `project-restored`; a different published change answers `already-published` -> `undo` summary (counts, backup dir) |
| `launch` | `operationId`, `sessionFile` (the imported file), `cwd`, `name`, `nonce` | runs under the operation lock. Refuses with `launch-cancelled`, `project-restored`, `project-not-published`, `not-imported` or `session-mismatch` when it cannot start. Order: record the intent, write the `attempt` marker, consume the intent, move to `destination-starting`, release the destination reservation, write the `spawning` marker, spawn `ompc --detach --new <name> --resume <file>` in `cwd` with env `OMPC_TRANSFER_OPERATION` and `OMPC_TRANSFER_NONCE`, write the `spawned` marker (`pid`). A definite spawn failure writes `failed`. Marker `launch.json` phases: `attempt`, `spawning`, `spawned`, `failed`. With a consumed intent, a marker of `attempt`, `failed` or none lets the same nonce run again, `spawned` answers `{ launched: true, replayed: true }`, and `spawning` answers `launch-already-consumed` (a spawn may exist; reconcile with `verify-arrival`) |
| `cancel-launch` | `operationId` | `result`: `cancelled` / `already-consumed` / `none`; `tombstoned` is true when no intent existed and a cancelled tombstone was written so a late launch is refused |
| `verify-arrival` | `operationId`, `nonce`, `sessionId`, `cwd` | reads `arrival.json` written by the destination extension at session start (`{nonce, sessionId, cwd, pid, hostId, label}`); `arrived` is true only when the launch was consumed and nonce, session id and cwd match -> `arrived`, `exited` (the recorded pid is no longer alive; the session still arrived), `hostId`, `label`, `pid`. When not arrived, `reason` is one of `launch-not-consumed`, `nonce-mismatch`, `no-arrival-record`, `arrival-unreadable`, `arrival-malformed`, `session-mismatch`, `cwd-mismatch` |
| `status` | `operationId` | `record` (destination journal), `reservation`, `reservationError?`, `launch`, `launched` (`{ pid }` after `spawned`, else null), `launchFailed`, `launchPhase` |
| `restore-project` | `operationId` | `restored[]`, `conflicts[]`, `publishedMarkerFlagged`; any restore attempt marks `project-published.json` as restored, so later `publish-project` and `launch` answer `project-restored` |
| `rollback` | `operationId`, `sessionId?` | runs under the operation lock. With no record and a `sessionId`, releases a destination reservation held by the operation. A `rolled-back` record replays, a `completed` record is refused. When the launch provably never reached the spawn (`failed`, or no `spawning` marker) the intent is left alone; otherwise it is cancelled, and `launch-already-consumed` answers when the destination started. Removes the session journal and artifact directory this operation created (`import.json` mode `created`, paths directly inside the destination session directory; any other copy is kept), releases the destination reservation, then `aborting` -> `rolled-back` -> `state`, `cancelled`, `importedRemoved`, `importedCopyKept`, `importedKeptReason?` |
| `release` | `operationId` | marks the destination record `completed` from `destination-starting`, releases the reservation if still held |
| `cleanup` | `operationId`, `removeBackups?` | removes staging; keeps undo backups unless asked, and removes them only after `completed` or `rolled-back` |

The helper resolves the OMP binary like `ompc`: `OMP_BIN`, else `omp` on PATH, else `$HOME/.bun/bin/omp`, else `$HOME/.local/bin/omp`.

`import-session`, `publish-project`, `launch`, `restore-project`, `rollback` and `cleanup` hold a per-operation lock. A second call for the same operation while one runs is answered `{ ok: false, code: "op-busy", retryable: true }`; the worker waits and repeats instead of racing it.

Worker-side timeouts per helper call: 120 s by default; 30 min for `inspect`, `import-session`, `publish-project`, `restore-project` and `cleanup`; each rsync attempt is limited to 30 min. Idempotent calls are retried twice after a transport failure. Before a mutating call is sent again the worker reads `status`, then waits out `op-busy` for up to 30 min.

## Source worker and extension contract

The extension never performs the transfer. `transfer.plan` and `transfer.commit` spawn the worker (`bun extension/src/transfer/worker.ts`, installed as `ompc-send`). The extension writes a private request file `<journalDir>/<operationId>/request.json` (0600): `{ operationId, hubUrl, token, renewalSecret, planId, planDigest, projectMode, acceptIncomplete, destination, session: { sessionId, sessionFile, cwd, title, launcherName, pid, hostId, instanceId } }`. Plans are stored by the worker `plan` mode at `<journalDir>/plans/<planId>.json` and bound to the digest.

Worker modes: `ompc-send plan --request <file> --json` (read-only preflight, prints `{ planId, digest, plan, preflight }`), `ompc-send run --operation <id>` (detached), `ompc-send recover --operation <id> --action <resume|retry-launch|rollback-source|restore-project|cleanup>`, `ompc-send status --operation <id>`. A local CLI `ompc send-to-host <sessionId> <destination> [--update-project|--session-only] [--yes]` builds the request for an inactive session only; a session with a live owner is refused with a message to use the dashboard.

Recovery actions: `resume` re-enters the pipeline from any state before departure (refused after `restore-project`); `retry-launch` re-enters launch and arrival from `source-departed` or `destination-starting`, never spawns a second destination for a consumed intent and repeats a failed source release; `rollback-source` cancels the destination launch through helper `rollback`, releases the source and ends `rolled-back`; `restore-project` (update only, refused once the destination started) undoes the update and then blocks `resume` and `retry-launch`; `cleanup` removes staging, and on a terminal record also repairs a held source reservation.

Publishing order inside `publishing`: `session-only` and `update` run `import-session` before `publish-project`, so a divergent or older destination copy is refused before any project write; `create` runs `publish-project` first because unpack needs the project directory. The worker then records the departure marker with `omp session moved` on the source.

The source reservation is released before the record becomes `completed` or `rolled-back`. When the release fails the record keeps its non-terminal state, the progress flag `sourceReleasePending` is set and the error is recorded; repeating `retry-launch` (after arrival) or `rollback-source` repeats the release.

Stop handshake for a live source session: the worker reserves the source id with `omp session reserve --role source` (this fences new prompts in the running process), writes `<journalDir>/<operationId>/stop-request.json`; the extension polls that file every 500 ms, checks `ctx.isIdle()`, no pending messages and no running async jobs, then writes `stop-ack.json` `{ ok: true }` and calls `ctx.shutdown()`, or `{ ok: false, reasons: string[] }` without shutting down. After an ok ack the extension checks once more that the stop request still exists, the operation is not `aborting` or terminal and the session can still stop; if not, it overwrites the ack with `{ ok: false, reasons }` and keeps running. The worker waits for the process `pid` to exit and its lease to clear, then runs `omp session pack`. The destination extension writes `arrival.json` at `session_start` when `OMPC_TRANSFER_OPERATION` and `OMPC_TRANSFER_NONCE` are set.

Worker ssh: executable from `OMPC_TRANSFER_SSH` (default `ssh`), options `-o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes`, `-p`, `-i` from validated config only, remote command exactly the validated helper path. rsync uses the same ssh command via `-e`, `--files-from`, no `--delete`, `--no-owner --no-group`.

## Hub contract

Extension RPC methods (feature `session.transfer.v1`, control access required, answered by the source session's extension): `transfer.destinations` `{}` -> `{ enabled, destinations: { name, hostId }[] }`; `transfer.plan` `{ destination, projectMode?, destinationPath? }` -> `{ planId, digest, plan, preflight }`; `transfer.commit` `{ planId, planDigest, projectMode, acceptIncomplete, operation: { id, token, renewalSecret, hubUrl } }` -> `{ operationId }`. The worker's hub URL is the extension's own `OMP_HUB_URL` when set to an http(s) URL; `operation.hubUrl` is the fallback.

REST, dashboard side (no per-user auth, same trust model as other controls, same rate limits and mutation-origin checks):
- `POST /api/hosts/:host/sessions/:instance/transfer/destinations|plan|commit`; commit makes the hub create the operation (random id, short-lived worker token, renewal secret; only SHA-256 verifiers are stored), refuses a second active operation for the same `sessionId`, then forwards the RPC with the secrets and answers `{ operationId }`.
- `GET /api/transfers`, `GET /api/transfers/:id` (no secrets), `POST /api/transfers/:id/cancel`, `POST /api/transfers/:id/recover` `{ action: "resume" | "retry-launch" | "rollback-source" | "restore-project" | "cleanup" }`, `POST /api/transfers/:id/abandon`. Cancel and recover append a command for the worker. Abandon is for an operation nobody drives: it is refused with 409 when the operation is terminal or finished, or when its worker reported in and was silent for less than 15 min. Otherwise the hub ends it as `rolled-back` with error `abandoned`, finished, both credentials revoked. It does not touch either host; the source reservation may need `ompc-send recover`.
- Worker side, `Authorization: Bearer <token>`: `POST /api/transfers/:id/worker/events` `{ state, detail?, error?, progress? }`; `GET /api/transfers/:id/worker/commands?after=<n>` -> `{ commands: { seq, type, payload }[] }`; `POST /api/transfers/:id/worker/commands/:seq/ack`; `POST /api/transfers/:id/worker/renew` with `Bearer <renewalSecret>` -> `{ token, expiresAt }`; `POST /api/transfers/:id/worker/finish` revokes the renewal secret.
- `/ws/dashboard` event `{ event: "transfer.changed", transfer }`. State file `transfers.json` in the hub state directory, atomic writes, corrupt file renamed aside like the session group file. Finished terminal operations are dropped from the file 14 days after their last update. A worker event never changes a terminal state, but until the worker finishes it still records `error` and `progress`.
