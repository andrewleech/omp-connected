import { describe, expect, test } from "bun:test";
import {
  TRANSFER_ABANDON_AFTER_MS,
  TRANSFER_FEATURE,
  type TransferPlanView,
  type TransferView,
} from "@/webui/lib/transfer-api";
import {
  ABANDON_CONFIRM,
  ABANDON_EXPLANATION,
  CONFLICT_CHOICES,
  CONFLICT_LABELS,
  DEFAULT_CONFLICT_CHOICE,
  type DialogState,
  type Handoff,
  REASON_BUSY,
  REASON_NOT_CONTROL,
  REASON_UNSUPPORTED,
  abandonInfo,
  cancelInfo,
  changePreviewSummary,
  commitBlockers,
  commitOutcomeUnknown,
  downtimeNotice,
  dropHandoff,
  findActiveTransfer,
  findDestinationSession,
  formatBytes,
  formatDuration,
  groupReassignment,
  incompleteReasons,
  initialDialogState,
  isNewer,
  isPendingHandoff,
  modeForChoice,
  nextPollDelay,
  pendingHandoffId,
  pendingPlanRequest,
  planFacts,
  primaryAction,
  promoteHandoff,
  readHandoffs,
  recoverOptions,
  reduceDialog,
  resolvePendingHandoff,
  sendToHostMenuState,
  shouldSelectDestination,
  sourceDowntimeMs,
  transferTimeline,
  writeHandoff,
} from "@/webui/lib/transfer-dialog";
import type { CollabSession, StorageLike } from "@/webui/lib/workspace";

const DESTINATION = { name: "worker", hostId: "user@worker-host" };

function makePlan(
  over: Partial<Omit<TransferPlanView, "project">> & {
    project?: Partial<TransferPlanView["project"]>;
  } = {},
): TransferPlanView {
  const { project, ...rest } = over;
  return {
    planId: "plan-1",
    digest: "digest-1",
    mode: "create",
    project: {
      adds: 0,
      replacements: 0,
      modeChanges: 0,
      unchanged: 0,
      destinationOnly: 0,
      totalBytes: 0,
      entries: [],
      entriesOmitted: 0,
      conflicts: [],
      warnings: [],
      secretFiles: [],
      ...project,
    },
    sourceProject: "/home/user/project",
    destinationProject: "/home/user/project",
    destinationExists: false,
    sessionId: "session-1",
    title: "Fix the build",
    launcherName: "project",
    children: null,
    archiveBytes: null,
    missingBlobs: [],
    externalReferences: [],
    skippedSymlinks: [],
    gitDirty: null,
    knownUsers: [],
    warnings: [],
    blockers: [],
    runtimeVersion: "",
    runtimeCompatible: null,
    ...rest,
  };
}

/** A plan-step state around `plan`. */
function planState(
  plan: TransferPlanView,
  over: Partial<DialogState> = {},
): DialogState {
  return {
    ...initialDialogState(),
    step: "plan",
    destinations: [DESTINATION],
    enabled: true,
    destination: "worker",
    plan,
    ...over,
  };
}

const T0 = "2026-11-21T00:00:00.000Z";
const at = (seconds: number) =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

function makeView(over: Partial<TransferView> = {}): TransferView {
  return {
    id: "op-1",
    sessionId: "session-1",
    host: "hub-host",
    instance: "inst-1",
    destination: "worker",
    state: "prepared",
    lastConfirmedState: "prepared",
    history: [{ state: "prepared", at: at(0) }],
    planDigest: "digest-1",
    projectMode: "session-only",
    workerStarted: true,
    createdAt: at(0),
    updatedAt: at(0),
    commands: [],
    finished: false,
    ...over,
  };
}

function failed(
  state: TransferView["state"],
  over: Partial<TransferView> = {},
): TransferView {
  return makeView({
    state,
    lastConfirmedState: "prepared",
    error: { code: "boom", message: "it broke", at: at(5) },
    ...over,
  });
}

function makeSession(over: Partial<CollabSession> = {}): CollabSession {
  return {
    host_id: "hub-host",
    instanceId: "inst-1",
    generation: 1,
    access: "control",
    startedAt: 1,
    sessionId: "session-1",
    ...over,
  };
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("sendToHostMenuState", () => {
  test("needs control access", () => {
    expect(
      sendToHostMenuState(
        { access: "view", features: [TRANSFER_FEATURE] },
        false,
      ),
    ).toEqual({ disabled: true, reason: REASON_NOT_CONTROL });
  });

  test("needs the advertised transfer feature", () => {
    expect(
      sendToHostMenuState({ access: "control", features: [] }, false),
    ).toEqual({
      disabled: true,
      reason: REASON_UNSUPPORTED,
    });
    expect(sendToHostMenuState({ access: "control" }, false)).toEqual({
      disabled: true,
      reason: REASON_UNSUPPORTED,
    });
    expect(
      sendToHostMenuState(
        { access: "control", features: ["session.fork.v1"] },
        false,
      ).reason,
    ).toBe(REASON_UNSUPPORTED);
  });

  test("is disabled with a reason while the agent is busy", () => {
    expect(
      sendToHostMenuState(
        { access: "control", features: [TRANSFER_FEATURE] },
        true,
      ),
    ).toEqual({ disabled: true, reason: REASON_BUSY });
  });

  test("access and support are reported before busy", () => {
    expect(
      sendToHostMenuState({ access: "view", features: [] }, true).reason,
    ).toBe(REASON_NOT_CONTROL);
    expect(
      sendToHostMenuState({ access: "control", features: [] }, true).reason,
    ).toBe(REASON_UNSUPPORTED);
  });

  test("is enabled for an idle control session with the feature", () => {
    expect(
      sendToHostMenuState(
        { access: "control", features: [TRANSFER_FEATURE] },
        false,
      ),
    ).toEqual({ disabled: false, reason: "" });
  });
});

describe("conflict box", () => {
  test("offers exactly the three choices with the specified labels", () => {
    expect([...CONFLICT_CHOICES]).toEqual(["update", "session-only", "cancel"]);
    expect(CONFLICT_LABELS).toEqual({
      update: "Update project with rsync",
      "session-only": "Leave project untouched; transfer session only",
      cancel: "Cancel",
    });
  });

  test("session-only is the default", () => {
    expect(DEFAULT_CONFLICT_CHOICE).toBe("session-only");
    expect(initialDialogState().choice).toBe("session-only");
  });

  test("modeForChoice maps choices to project modes", () => {
    expect(modeForChoice(false, "session-only")).toBe("create");
    expect(modeForChoice(false, "update")).toBe("create");
    expect(modeForChoice(true, "update")).toBe("update");
    expect(modeForChoice(true, "session-only")).toBe("session-only");
    expect(modeForChoice(true, "cancel")).toBeNull();
  });

  test("Cancel turns the primary button into a close action", () => {
    const state = planState(
      makePlan({ destinationExists: true, mode: "session-only" }),
      {
        choice: "cancel",
      },
    );
    expect(primaryAction(state, false)).toEqual({
      kind: "close",
      label: "Cancel",
      disabled: false,
      reasons: [],
    });
  });

  test("session-only sends without a project preview", () => {
    const state = planState(
      makePlan({ destinationExists: true, mode: "session-only" }),
    );
    const action = primaryAction(state, false);
    expect(action.kind).toBe("commit");
    expect(action.label).toBe("Send session only to worker");
    expect(action.disabled).toBe(false);
  });

  test("update cannot be confirmed until its own preview is shown", () => {
    const sessionOnlyPlan = makePlan({
      destinationExists: true,
      mode: "session-only",
    });
    const waiting = planState(sessionOnlyPlan, { choice: "update" });
    const action = primaryAction(waiting, false);
    expect(action.disabled).toBe(true);
    expect(action.reasons).toContain(
      "The preview does not match the selected project option.",
    );
    const loading = planState(sessionOnlyPlan, {
      choice: "update",
      pendingPlan: { seq: 2, projectMode: "update" },
      planSeq: 2,
    });
    expect(primaryAction(loading, false).reasons).toContain(
      "Loading the project preview.",
    );
    const ready = planState(
      makePlan({ destinationExists: true, mode: "update" }),
      {
        choice: "update",
      },
    );
    const go = primaryAction(ready, false);
    expect(go.disabled).toBe(false);
    expect(go.label).toBe("Update project and send to worker");
  });

  test("a new project is created without the box", () => {
    const action = primaryAction(planState(makePlan()), false);
    expect(action.label).toBe("Send to worker");
    expect(action.disabled).toBe(false);
  });

  test("the update preview line lists the counts", () => {
    expect(
      changePreviewSummary(
        makePlan({
          project: {
            adds: 3,
            replacements: 1,
            destinationOnly: 12,
            totalBytes: 2048,
          },
        }),
      ),
    ).toBe(
      "3 additions, 1 replacement, 0 mode changes, 12 destination-only entries kept, 2.0 KiB to copy",
    );
  });
});

describe("commit enabling", () => {
  test("conflicts block the commit", () => {
    const plan = makePlan({
      project: {
        conflicts: [
          {
            path: "src",
            sourceKind: "file",
            destinationKind: "dir",
            reason: "non-empty directory",
          },
        ],
      },
    });
    const reasons = commitBlockers(planState(plan), false);
    expect(reasons).toEqual([
      "1 project conflict must be resolved on the destination, then plan again.",
    ]);
    expect(primaryAction(planState(plan), false).disabled).toBe(true);
  });

  test("an incomplete archive needs the explicit checkbox", () => {
    const plan = makePlan({
      missingBlobs: ["b1", "b2"],
      skippedSymlinks: ["a"],
    });
    expect(incompleteReasons(plan)).toEqual([
      "2 referenced assets missing",
      "1 artifact symlink skipped",
    ]);
    expect(commitBlockers(planState(plan), false)).toEqual([
      "Accept the incomplete archive to continue.",
    ]);
    expect(
      commitBlockers(planState(plan, { acceptIncomplete: true }), false),
    ).toEqual([]);
  });

  test("references outside the archive count as incomplete", () => {
    expect(
      incompleteReasons(makePlan({ externalReferences: ["/home/user/x"] })),
    ).toEqual(["1 reference to history or paths outside the archive"]);
  });

  test("a busy agent blocks the commit with the reason", () => {
    expect(commitBlockers(planState(makePlan()), true)).toEqual([REASON_BUSY]);
  });

  test("preflight blockers are carried through", () => {
    expect(
      commitBlockers(
        planState(makePlan({ blockers: ["destination owner exists"] })),
        false,
      ),
    ).toEqual(["destination owner exists"]);
  });

  test("no plan, no commit", () => {
    expect(commitBlockers(initialDialogState(), false)).toEqual([
      "No plan yet.",
    ]);
    expect(primaryAction(initialDialogState(), false).kind).toBe("none");
  });
});

describe("step machine", () => {
  function started(): DialogState {
    let state = reduceDialog(initialDialogState(), {
      type: "destinations-loaded",
      enabled: true,
      destinations: [DESTINATION],
    });
    state = reduceDialog(state, { type: "select-destination", name: "worker" });
    return state;
  }

  test("selecting a destination asks for a plan without a mode", () => {
    const state = started();
    expect(state.step).toBe("planning");
    expect(state.destination).toBe("worker");
    expect(pendingPlanRequest(state)).toEqual({ destination: "worker" });
  });

  test("an unknown destination is ignored", () => {
    const state = reduceDialog(
      reduceDialog(initialDialogState(), {
        type: "destinations-loaded",
        enabled: true,
        destinations: [DESTINATION],
      }),
      { type: "select-destination", name: "other" },
    );
    expect(state.step).toBe("destination");
    expect(state.pendingPlan).toBeNull();
  });

  test("destination load failure keeps the picker with an error", () => {
    const state = reduceDialog(initialDialogState(), {
      type: "destinations-failed",
      message: "Hub unreachable",
    });
    expect(state.destinations).toBeNull();
    expect(state.error).toBe("Hub unreachable");
  });

  test("a loaded plan moves to the plan step", () => {
    const state = reduceDialog(started(), {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan(),
    });
    expect(state.step).toBe("plan");
    expect(state.pendingPlan).toBeNull();
    expect(state.plan?.planId).toBe("plan-1");
  });

  test("a failed first plan returns to the picker", () => {
    const state = reduceDialog(started(), {
      type: "plan-failed",
      seq: 1,
      message: "no helper",
    });
    expect(state.step).toBe("destination");
    expect(state.destination).toBeNull();
    expect(state.error).toBe("no helper");
  });

  test("the host's own default mode is aligned with the default choice", () => {
    const state = reduceDialog(started(), {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ destinationExists: true, mode: "update" }),
    });
    expect(state.pendingPlan).toEqual({ seq: 2, projectMode: "session-only" });
    expect(primaryAction(state, false).disabled).toBe(true);
  });

  test("an answer in another mode than requested is flagged", () => {
    const state = reduceDialog(
      reduceDialog(started(), {
        type: "plan-loaded",
        seq: 1,
        plan: makePlan({ destinationExists: true, mode: "session-only" }),
      }),
      { type: "choose", choice: "update" },
    );
    const next = reduceDialog(state, {
      type: "plan-loaded",
      seq: 2,
      requested: "update",
      plan: makePlan({ destinationExists: true, mode: "session-only" }),
    });
    expect(next.error).toContain('planned "session-only" instead of "update"');
    expect(commitBlockers(next, false)).toContain(
      "The preview does not match the selected project option.",
    );
  });

  test("choosing update requests the update preview and keeps the old plan shown", () => {
    const shown = reduceDialog(started(), {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ destinationExists: true, mode: "session-only" }),
    });
    const state = reduceDialog(shown, { type: "choose", choice: "update" });
    expect(state.choice).toBe("update");
    expect(state.pendingPlan).toEqual({ seq: 2, projectMode: "update" });
    expect(pendingPlanRequest(state)).toEqual({
      destination: "worker",
      projectMode: "update",
    });
    expect(state.plan?.mode).toBe("session-only");
    const loaded = reduceDialog(state, {
      type: "plan-loaded",
      seq: 2,
      requested: "update",
      plan: makePlan({ destinationExists: true, mode: "update" }),
    });
    expect(loaded.pendingPlan).toBeNull();
    expect(primaryAction(loaded, false).disabled).toBe(false);
  });

  test("a stale plan answer is ignored", () => {
    const shown = reduceDialog(started(), {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ destinationExists: true, mode: "session-only" }),
    });
    const pending = reduceDialog(shown, { type: "choose", choice: "update" });
    const back = reduceDialog(pending, {
      type: "choose",
      choice: "session-only",
    });
    expect(back.pendingPlan).toBeNull();
    const late = reduceDialog(back, {
      type: "plan-loaded",
      seq: 2,
      requested: "update",
      plan: makePlan({ destinationExists: true, mode: "update" }),
    });
    expect(late).toBe(back);
    expect(
      reduceDialog(back, { type: "plan-failed", seq: 2, message: "x" }),
    ).toBe(back);
  });

  test("a failed update preview falls back to the shown plan's choice", () => {
    const shown = reduceDialog(started(), {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ destinationExists: true, mode: "session-only" }),
    });
    const pending = reduceDialog(shown, { type: "choose", choice: "update" });
    const state = reduceDialog(pending, {
      type: "plan-failed",
      seq: 2,
      message: "rsync missing",
    });
    expect(state.step).toBe("plan");
    expect(state.choice).toBe("session-only");
    expect(state.error).toBe("rsync missing");
    expect(state.plan?.mode).toBe("session-only");
  });

  test("Cancel as a choice requests nothing", () => {
    const shown = planState(
      makePlan({ destinationExists: true, mode: "session-only" }),
    );
    const state = reduceDialog(shown, { type: "choose", choice: "cancel" });
    expect(state.choice).toBe("cancel");
    expect(state.pendingPlan).toBeNull();
  });

  test("choices are ignored outside the plan step", () => {
    const state = initialDialogState();
    expect(reduceDialog(state, { type: "choose", choice: "update" })).toBe(
      state,
    );
  });

  test("replan re-requests the plan for the selected mode", () => {
    const state = reduceDialog(
      planState(makePlan({ destinationExists: true, mode: "update" }), {
        choice: "update",
      }),
      { type: "replan" },
    );
    expect(state.pendingPlan).toEqual({ seq: 1, projectMode: "update" });
  });

  test("acceptance survives a re-plan of the same archive but not a changed one", () => {
    const incomplete = makePlan({ missingBlobs: ["b1"] });
    const accepted = planState(incomplete, {
      acceptIncomplete: true,
      pendingPlan: { seq: 1 },
      planSeq: 1,
    });
    const same = reduceDialog(accepted, {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ missingBlobs: ["b1"], planId: "plan-2" }),
    });
    expect(same.acceptIncomplete).toBe(true);
    const changed = reduceDialog(accepted, {
      type: "plan-loaded",
      seq: 1,
      plan: makePlan({ missingBlobs: ["b1", "b2"] }),
    });
    expect(changed.acceptIncomplete).toBe(false);
  });

  test("commit is refused while blocked or busy", () => {
    const blocked = planState(makePlan({ missingBlobs: ["b1"] }));
    expect(
      reduceDialog(blocked, { type: "commit-requested", agentBusy: false }),
    ).toBe(blocked);
    const ok = planState(makePlan());
    expect(
      reduceDialog(ok, { type: "commit-requested", agentBusy: true }),
    ).toBe(ok);
    expect(
      reduceDialog(ok, { type: "commit-requested", agentBusy: false }).step,
    ).toBe("committing");
  });

  test("commit success moves to progress; failure returns to the plan with the error", () => {
    const committing = reduceDialog(planState(makePlan()), {
      type: "commit-requested",
      agentBusy: false,
    });
    const progress = reduceDialog(committing, {
      type: "commit-accepted",
      operationId: "op-1",
    });
    expect(progress.step).toBe("progress");
    expect(progress.operationId).toBe("op-1");
    const retry = reduceDialog(committing, {
      type: "commit-failed",
      message: "Rate limit",
    });
    expect(retry.step).toBe("plan");
    expect(retry.error).toBe("Rate limit");
  });

  test("a duplicate commit attaches to the running operation", () => {
    const committing = reduceDialog(planState(makePlan()), {
      type: "commit-requested",
      agentBusy: false,
    });
    const state = reduceDialog(committing, {
      type: "attach",
      operationId: "op-9",
    });
    expect(state.step).toBe("progress");
    expect(state.operationId).toBe("op-9");
    expect(state.error).toBeNull();
  });

  test("back returns to the picker and discards the plan", () => {
    const state = reduceDialog(
      planState(makePlan({ destinationExists: true }), {
        choice: "update",
        acceptIncomplete: true,
      }),
      { type: "back" },
    );
    expect(state.step).toBe("destination");
    expect(state.plan).toBeNull();
    expect(state.destination).toBeNull();
    expect(state.choice).toBe("session-only");
    expect(state.acceptIncomplete).toBe(false);
  });

  test("back is ignored during progress", () => {
    const state = reduceDialog(planState(makePlan()), {
      type: "commit-accepted",
      operationId: "op-1",
    });
    expect(reduceDialog(state, { type: "back" })).toBe(state);
  });
});

describe("plan facts", () => {
  test("lists the session and project facts and leaves empty ones out", () => {
    const rows = planFacts(
      makePlan({
        children: 2,
        archiveBytes: 2048,
        title: "Fix the build",
        launcherName: "project.review",
        gitDirty: true,
        runtimeVersion: "1.2.3",
        runtimeCompatible: false,
      }),
      DESTINATION,
    );
    expect(rows).toEqual([
      ["Title", "Fix the build"],
      ["Session ID", "session-1"],
      ["Launcher name", "project.review"],
      ["Destination host", "worker (user@worker-host)"],
      ["Source project", "/home/user/project"],
      ["Destination project", "/home/user/project"],
      ["Nested histories", "2"],
      ["Session size", "2.0 KiB"],
      ["Destination runtime", "1.2.3 (incompatible)"],
      ["Git state", "Uncommitted changes on the destination project"],
    ]);
  });

  test("omits unknown values", () => {
    const labels = planFacts(makePlan(), undefined).map(([label]) => label);
    expect(labels).not.toContain("Nested histories");
    expect(labels).not.toContain("Git state");
    expect(labels).not.toContain("Destination host");
  });

  test("formats sizes and durations", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(150 * 1024)).toBe("150 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(3_660_000)).toBe("1h 01m");
  });
});

describe("recover actions", () => {
  const actions = (view: TransferView) =>
    recoverOptions(view).map((o) => o.action);

  test("an operation without an error offers none while running", () => {
    expect(actions(makeView({ state: "staged" }))).toEqual([]);
  });

  test("failure before publication offers source rollback and cleanup", () => {
    for (const state of [
      "prepared",
      "source-stopping",
      "source-stopped",
      "staged",
    ] as const)
      expect(actions(failed(state))).toEqual([
        "resume",
        "rollback-source",
        "cleanup",
      ]);
  });

  test("a failed publication offers project restore only for an update", () => {
    expect(actions(failed("publishing", { projectMode: "update" }))).toEqual([
      "resume",
      "restore-project",
      "rollback-source",
      "cleanup",
    ]);
    expect(
      actions(failed("publishing", { projectMode: "session-only" })),
    ).toEqual(["resume", "rollback-source", "cleanup"]);
  });

  test("resume is offered only before the destination is touched or while publishing", () => {
    expect(actions(failed("source-departed"))).not.toContain("resume");
    expect(actions(failed("destination-starting"))).not.toContain("resume");
    expect(actions(failed("aborting"))).not.toContain("resume");
    expect(actions(makeView({ state: "staged" }))).not.toContain("resume");
    const option = recoverOptions(failed("staged")).find(
      (o) => o.action === "resume",
    );
    expect(option?.label).toBe("Resume transfer");
    expect(option?.description).toBe(
      "Continues the transfer from the last confirmed step.",
    );
  });

  test("a failed launch offers retry and a checked rollback", () => {
    expect(actions(failed("source-departed"))).toEqual([
      "retry-launch",
      "rollback-source",
    ]);
    expect(actions(failed("destination-starting"))).toEqual([
      "retry-launch",
      "rollback-source",
    ]);
  });

  test("a failed abort offers rollback and cleanup", () => {
    expect(actions(failed("aborting"))).toEqual(["rollback-source", "cleanup"]);
  });

  test("finished operations offer cleanup or restore until the worker finishes", () => {
    expect(actions(makeView({ state: "completed" }))).toEqual(["cleanup"]);
    expect(actions(makeView({ state: "completed", finished: true }))).toEqual(
      [],
    );
    expect(
      actions(makeView({ state: "rolled-back", projectMode: "update" })),
    ).toEqual(["restore-project", "cleanup"]);
    expect(
      actions(makeView({ state: "rolled-back", projectMode: "session-only" })),
    ).toEqual(["cleanup"]);
  });

  test("every option carries a label and description", () => {
    for (const option of recoverOptions(failed("source-departed"))) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  test("a waiting request marks its action pending until acknowledged", () => {
    const command = {
      seq: 1,
      type: "recover" as const,
      payload: { action: "retry-launch" },
      createdAt: at(6),
    };
    const waiting = failed("source-departed", { commands: [command] });
    expect(
      recoverOptions(waiting).find((o) => o.action === "retry-launch")?.pending,
    ).toBe(true);
    expect(
      recoverOptions(waiting).find((o) => o.action === "rollback-source")
        ?.pending,
    ).toBe(false);
    const acked = failed("source-departed", {
      commands: [{ ...command, ackedAt: at(7) }],
    });
    expect(
      recoverOptions(acked).find((o) => o.action === "retry-launch")?.pending,
    ).toBe(false);
  });
});

describe("cancel", () => {
  test("before publication it removes staging and says nothing is published", () => {
    const info = cancelInfo(makeView({ state: "staged" }));
    expect(info.available).toBe(true);
    expect(info.label).toBe("Cancel transfer");
    expect(info.explanation).toContain("Nothing is published yet");
  });

  test("during publication it requests a safe stop at a recorded boundary", () => {
    const info = cancelInfo(makeView({ state: "publishing" }));
    expect(info.available).toBe(true);
    expect(info.label).toBe("Request safe stop");
    expect(info.explanation).toContain("recorded boundary");
  });

  test("once the destination starts it points to a reverse transfer", () => {
    for (const state of ["source-departed", "destination-starting"] as const) {
      const info = cancelInfo(makeView({ state }));
      expect(info.available).toBe(true);
      expect(info.explanation).toContain("send it back");
    }
  });

  test("it is unavailable while aborting and once settled", () => {
    expect(cancelInfo(makeView({ state: "aborting" })).available).toBe(false);
    expect(cancelInfo(makeView({ state: "completed" })).available).toBe(false);
    expect(cancelInfo(makeView({ state: "rolled-back" })).available).toBe(
      false,
    );
    expect(
      cancelInfo(makeView({ state: "publishing", finished: true })).available,
    ).toBe(false);
  });

  test("a waiting cancel command is pending", () => {
    const view = makeView({
      state: "staged",
      commands: [{ seq: 1, type: "cancel", payload: {}, createdAt: at(1) }],
    });
    expect(cancelInfo(view).pending).toBe(true);
  });
});

describe("progress", () => {
  test("the timeline marks done, current and pending steps", () => {
    const view = makeView({
      state: "publishing",
      lastConfirmedState: "publishing",
      history: [
        { state: "prepared", at: at(0) },
        { state: "source-stopping", at: at(1) },
        { state: "source-stopped", at: at(2) },
        { state: "staged", at: at(3) },
        { state: "publishing", at: at(4) },
      ],
    });
    const steps = transferTimeline(view);
    expect(steps.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
    expect(steps[1]?.at).toBe(at(1));
    expect(steps.map((s) => s.state)).toEqual([
      "prepared",
      "source-stopping",
      "source-stopped",
      "staged",
      "publishing",
      "source-departed",
      "destination-starting",
      "completed",
    ]);
  });

  test("an error marks the step it stopped at as failed", () => {
    const steps = transferTimeline(failed("publishing"));
    expect(steps.find((s) => s.state === "publishing")?.status).toBe("failed");
    expect(steps.find((s) => s.state === "prepared")?.status).toBe("done");
    expect(steps.find((s) => s.state === "completed")?.status).toBe("pending");
  });

  test("completed shows every step done", () => {
    const steps = transferTimeline(
      makeView({ state: "completed", lastConfirmedState: "completed" }),
    );
    expect(steps.every((s) => s.status === "done")).toBe(true);
  });

  test("a rollback shows the abort branch and skips steps never reached", () => {
    const steps = transferTimeline(
      makeView({
        state: "rolled-back",
        lastConfirmedState: "rolled-back",
        history: [
          { state: "prepared", at: at(0) },
          { state: "source-stopping", at: at(1) },
          { state: "aborting", at: at(2) },
          { state: "rolled-back", at: at(3) },
        ],
      }),
    );
    const status = (state: string) =>
      steps.find((s) => s.state === state)?.status;
    expect(status("source-stopping")).toBe("done");
    expect(status("source-stopped")).toBe("skipped");
    expect(status("completed")).toBe("skipped");
    expect(status("aborting")).toBe("done");
    expect(status("rolled-back")).toBe("done");
  });

  test("the downtime notice appears from source stop and changes after a failure", () => {
    expect(downtimeNotice(makeView({ state: "prepared" }))).toBeNull();
    expect(downtimeNotice(makeView({ state: "completed" }))).toBeNull();
    expect(downtimeNotice(makeView({ state: "source-stopping" }))).toContain(
      "Closing this window does not stop the transfer",
    );
    expect(downtimeNotice(failed("source-stopped"))).toContain(
      "recovery action",
    );
  });

  test("source downtime runs to completion or to now", () => {
    const history = [
      { state: "prepared" as const, at: at(0) },
      { state: "source-stopping" as const, at: at(10) },
    ];
    const now = Date.parse(at(100));
    expect(sourceDowntimeMs(makeView({ history }), now)).toBe(90_000);
    expect(
      sourceDowntimeMs(
        makeView({
          state: "completed",
          history: [...history, { state: "completed" as const, at: at(40) }],
        }),
        now,
      ),
    ).toBe(30_000);
    expect(sourceDowntimeMs(makeView(), now)).toBeNull();
  });

  test("older snapshots do not replace newer ones", () => {
    const held = makeView({ updatedAt: at(10) });
    expect(isNewer(undefined, held)).toBe(true);
    expect(isNewer(held, makeView({ updatedAt: at(9) }))).toBe(false);
    expect(isNewer(held, makeView({ updatedAt: at(10) }))).toBe(true);
    expect(isNewer(held, makeView({ updatedAt: at(11) }))).toBe(true);
  });

  test("polling backs off after failures, up to a cap", () => {
    expect([0, 1, 2, 3, 10].map(nextPollDelay)).toEqual([
      2000, 4000, 8000, 15_000, 15_000,
    ]);
  });

  test("the running operation for a session is found by host and instance or session id", () => {
    const running = makeView({ id: "a", updatedAt: at(1) });
    const newer = makeView({ id: "b", updatedAt: at(2) });
    const done = makeView({ id: "c", state: "completed", updatedAt: at(3) });
    const other = makeView({
      id: "d",
      host: "other",
      instance: "x",
      sessionId: "other",
    });
    expect(
      findActiveTransfer([running, newer, done, other], {
        host: "hub-host",
        instance: "inst-1",
      })?.id,
    ).toBe("b");
    expect(
      findActiveTransfer([other], { host: "hub-host", instance: "inst-1" }),
    ).toBeUndefined();
    expect(
      findActiveTransfer([other], {
        host: "x",
        instance: "y",
        sessionId: "other",
      })?.id,
    ).toBe("d");
  });
});

describe("handoff", () => {
  const handoff: Handoff = {
    transferId: "op-1",
    sessionId: "session-1",
    sourceHost: "hub-host",
    sourceInstance: "inst-1",
    memberKey: "hub-host:label:project",
    destinationHostId: "worker-host",
    createdAt: 0,
  };
  const source = makeSession();
  const destination = makeSession({
    host_id: "worker-host",
    instanceId: "inst-2",
    startedAt: 5,
  });
  const elsewhere = makeSession({
    host_id: "other-host",
    instanceId: "inst-3",
    startedAt: 9,
  });

  test("finds the registered destination, never the source", () => {
    expect(
      findDestinationSession([source, destination, elsewhere], handoff),
    ).toBe(destination);
    expect(findDestinationSession([source], handoff)).toBeUndefined();
  });

  test("without a known destination host the newest non-source session matches", () => {
    expect(
      findDestinationSession([source, destination, elsewhere], {
        ...handoff,
        destinationHostId: "",
      }),
    ).toBe(elsewhere);
  });

  test("a session with another id does not match", () => {
    expect(
      findDestinationSession(
        [makeSession({ host_id: "worker-host", sessionId: "other" })],
        handoff,
      ),
    ).toBeUndefined();
  });

  test("the destination is selected only while the source is still selected", () => {
    expect(shouldSelectDestination(null, handoff)).toBe(true);
    expect(shouldSelectDestination(source, handoff)).toBe(true);
    expect(shouldSelectDestination(elsewhere, handoff)).toBe(false);
  });

  test("the custom group of the old member moves to the new one", () => {
    const groups = [
      { id: "g1", name: "Work", sessions: ["hub-host:label:project"] },
      { id: "g2", name: "Other", sessions: [] },
    ];
    expect(
      groupReassignment(
        groups,
        "hub-host:label:project",
        "worker-host:label:project",
      ),
    ).toBe("g1");
    expect(
      groupReassignment(
        groups,
        "hub-host:label:missing",
        "worker-host:label:project",
      ),
    ).toBeNull();
    expect(
      groupReassignment(
        [{ id: "g1", name: "Work", sessions: ["a", "b"] }],
        "a",
        "b",
      ),
    ).toBeNull();
  });

  test("handoffs persist, expire and drop", () => {
    const storage = memoryStorage();
    const fresh = { ...handoff, createdAt: Date.now() };
    writeHandoff(storage, fresh);
    writeHandoff(storage, { ...fresh, transferId: "op-2" });
    writeHandoff(storage, { ...fresh, memberKey: "replaced" });
    expect(readHandoffs(storage).map((h) => h.transferId)).toEqual([
      "op-2",
      "op-1",
    ]);
    expect(
      readHandoffs(storage).find((h) => h.transferId === "op-1")?.memberKey,
    ).toBe("replaced");
    expect(readHandoffs(storage, fresh.createdAt + 25 * 3600 * 1000)).toEqual(
      [],
    );
    dropHandoff(storage, "op-1");
    expect(readHandoffs(storage).map((h) => h.transferId)).toEqual(["op-2"]);
  });

  test("unreadable stored handoffs read as none", () => {
    const storage = memoryStorage();
    storage.setItem("omp-hub-transfer-handoffs/v1", "{not json");
    expect(readHandoffs(storage)).toEqual([]);
    storage.setItem(
      "omp-hub-transfer-handoffs/v1",
      JSON.stringify([{ transferId: 1 }, "x"]),
    );
    expect(readHandoffs(storage)).toEqual([]);
  });
});

describe("abandon", () => {
  test("a worker that never reported in can be abandoned at once", () => {
    const view = makeView({ workerStarted: false });
    expect(abandonInfo(view, Date.parse(at(1)))).toEqual({
      eligible: true,
      since: at(0),
    });
  });

  test("a silent worker becomes eligible after the hub's limit", () => {
    const view = makeView({ updatedAt: at(0) });
    const start = Date.parse(at(0));
    expect(abandonInfo(view, start + 60_000).eligible).toBe(false);
    expect(
      abandonInfo(view, start + TRANSFER_ABANDON_AFTER_MS - 1).eligible,
    ).toBe(false);
    expect(abandonInfo(view, start + TRANSFER_ABANDON_AFTER_MS).eligible).toBe(
      true,
    );
  });

  test("a settled operation is never eligible", () => {
    const late = Date.parse(at(0)) + 2 * TRANSFER_ABANDON_AFTER_MS;
    expect(abandonInfo(makeView({ state: "completed" }), late).eligible).toBe(
      false,
    );
    expect(abandonInfo(makeView({ state: "rolled-back" }), late).eligible).toBe(
      false,
    );
    expect(
      abandonInfo(makeView({ workerStarted: false, finished: true }), late)
        .eligible,
    ).toBe(false);
  });

  test("the confirmation points at ompc-send recover", () => {
    expect(ABANDON_CONFIRM).toContain("ompc-send recover");
    expect(ABANDON_EXPLANATION).toContain("source host");
  });
});

describe("handoff before the commit answers", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const pending: Handoff = {
    transferId: pendingHandoffId("hub-host", "inst-1"),
    sessionId: "session-1",
    sourceHost: "hub-host",
    sourceInstance: "inst-1",
    memberKey: "hub-host:label:project",
    destinationHostId: "worker-host",
    createdAt: 1_000_000,
  };

  test("the pending id is stable and recognised", () => {
    expect(pending.transferId).toBe("pending:hub-host:inst-1");
    expect(isPendingHandoff(pending)).toBe(true);
    expect(isPendingHandoff({ transferId: "op-1" })).toBe(false);
  });

  test("the newest operation created since the commit is adopted", () => {
    const older = makeView({ id: "a", createdAt: iso(1_002_000) });
    const newer = makeView({ id: "b", createdAt: iso(1_004_000) });
    const result = resolvePendingHandoff(pending, [older, newer], 1_010_000);
    expect(result.action).toBe("promote");
    expect(result.action === "promote" && result.transfer.id).toBe("b");
  });

  test("operations of other sessions or from before the commit do not match", () => {
    const other = makeView({ instance: "other", createdAt: iso(1_005_000) });
    const before = makeView({ createdAt: iso(0) });
    expect(resolvePendingHandoff(pending, [other, before], 1_010_000)).toEqual({
      action: "keep",
    });
  });

  test("an unmatched handoff is dropped once it is too old", () => {
    expect(resolvePendingHandoff(pending, [], 1_000_000 + 600_000)).toEqual({
      action: "keep",
    });
    expect(resolvePendingHandoff(pending, [], 1_000_000 + 600_001)).toEqual({
      action: "drop",
    });
  });

  test("promoting re-keys the handoff to the operation id", () => {
    const storage = memoryStorage();
    writeHandoff(storage, { ...pending, createdAt: Date.now() });
    promoteHandoff(storage, pending.transferId, "op-7");
    const stored = readHandoffs(storage);
    expect(stored.map((h) => h.transferId)).toEqual(["op-7"]);
    expect(stored[0]?.memberKey).toBe("hub-host:label:project");
    promoteHandoff(storage, pending.transferId, "op-8");
    expect(readHandoffs(storage).map((h) => h.transferId)).toEqual(["op-7"]);
  });

  test("only failures that may have created the operation keep the handoff", () => {
    for (const kind of ["unreachable", "timeout", "server"] as const)
      expect(commitOutcomeUnknown(kind)).toBe(true);
    for (const kind of [
      "duplicate",
      "unsupported",
      "rate-limited",
      "forbidden",
      "not-found",
      "invalid",
    ] as const)
      expect(commitOutcomeUnknown(kind)).toBe(false);
  });
});
