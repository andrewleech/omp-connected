import { describe, expect, test } from "bun:test";
import {
  type StorageLike,
  WORKSPACE_STORAGE_KEY,
  canRequestAccess,
  groupSessions,
  readWorkspace,
  resolveRememberedSession,
  sessionKey,
  sessionLabel,
  workspaceSignature,
  writeWorkspace,
} from "@/webui/lib/workspace";

class MemoryStorage implements StorageLike {
  value: string | null = null;
  getItem(key: string): string | null {
    return key === WORKSPACE_STORAGE_KEY ? this.value : null;
  }
  setItem(key: string, value: string): void {
    if (key === WORKSPACE_STORAGE_KEY) this.value = value;
  }
}

const alpha = {
  host_id: "andrew@alpha",
  instanceId: "alpha-room",
  generation: 2,
  access: "control" as const,
  startedAt: 100,
};
const beta = {
  host_id: "andrew@beta",
  instanceId: "beta-room",
  generation: 1,
  access: "view" as const,
  startedAt: 200,
};

describe("fleet dashboard workspace", () => {
  test("keeps project assignment while falling back to host and recency", () => {
    const groups = [
      { id: "g1", name: "Project", sessions: [sessionKey(beta)] },
    ];
    const grouped = groupSessions([alpha, beta], groups);
    expect(grouped[0]).toMatchObject({ id: "g1", sessions: [beta] });
    expect(grouped[1]).toMatchObject({
      id: "host:andrew@alpha",
      sessions: [alpha],
    });
  });

  test("restores only a currently available remembered session", () => {
    expect(resolveRememberedSession([alpha, beta], sessionKey(alpha))).toEqual(
      alpha,
    );
    expect(resolveRememberedSession([beta], sessionKey(alpha))).toBeNull();
  });

  test("does not offer control for a view-only room", () => {
    expect(canRequestAccess(beta, "view")).toBe(true);
    expect(canRequestAccess(beta, "control")).toBe(false);
    expect(canRequestAccess(alpha, "control")).toBe(true);
  });

  test("keeps the same signature for a re-fetched session object, changes for a different room or access", () => {
    const refetched = { ...alpha };
    expect(workspaceSignature(alpha, "control")).toBe(
      workspaceSignature(refetched, "control"),
    );
    expect(workspaceSignature(alpha, "view")).not.toBe(
      workspaceSignature(alpha, "control"),
    );
    expect(workspaceSignature(alpha, "control")).not.toBe(
      workspaceSignature(
        { ...alpha, generation: alpha.generation + 1 },
        "control",
      ),
    );
    expect(workspaceSignature(null, "control")).toBe(null);
  });

  test("persists workspace metadata", () => {
    const storage = new MemoryStorage();
    writeWorkspace(storage, {
      version: 1,
      groups: [{ id: "g1", name: "Project", sessions: [sessionKey(alpha)] }],
      selected: sessionKey(alpha),
      inspector: "controls",
    });
    const restored = readWorkspace(storage);
    expect(restored.groups).toEqual([
      { id: "g1", name: "Project", sessions: [sessionKey(alpha)] },
    ]);
    expect(restored.selected).toBe(sessionKey(alpha));
    expect(restored.inspector).toBe("controls");
  });

  test("falls back to defaults on corrupt storage", () => {
    const storage = new MemoryStorage();
    storage.value = "not json";
    expect(readWorkspace(storage)).toEqual({
      version: 1,
      groups: [],
      selected: null,
      inspector: "controls",
    });
  });

  test("labels a session by its project directory basename", () => {
    expect(sessionLabel({ ...alpha, cwd: "/home/andrew/studio/mesh" })).toBe(
      "mesh",
    );
    expect(sessionLabel({ ...alpha, cwd: "/home/andrew/studio/mesh/" })).toBe(
      "mesh",
    );
  });

  test("falls back to verbose name then instance id without a cwd", () => {
    expect(
      sessionLabel({ ...alpha, sessionName: "Support multiple providers" }),
    ).toBe("Support multiple providers");
    expect(sessionLabel(alpha)).toBe(alpha.instanceId);
  });
});