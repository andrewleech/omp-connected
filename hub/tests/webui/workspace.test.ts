import { describe, expect, test } from "bun:test";
import {
  INSPECTOR_PANES,
  type StorageLike,
  WORKSPACE_STORAGE_KEY,
  canRequestAccess,
  defaultRequestedAccess,
  dropLegacyGroups,
  groupMemberKey,
  groupSessions,
  legacyGroupsForImport,
  readLegacyGroups,
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
      { id: "g1", name: "Project", sessions: [groupMemberKey(beta)] },
    ];
    const grouped = groupSessions([alpha, beta], groups);
    expect(grouped[0]).toMatchObject({ id: "g1", sessions: [beta] });
    expect(grouped[1]).toMatchObject({
      id: "host:andrew@alpha",
      sessions: [alpha],
    });
  });

  test("keys group members by label, else by instance, never by generation", () => {
    expect(groupMemberKey({ ...alpha, label: "mesh.install" })).toBe(
      "andrew@alpha:label:mesh.install",
    );
    expect(groupMemberKey(alpha)).toBe("andrew@alpha:instance:alpha-room");
    expect(groupMemberKey({ ...alpha, label: "" })).toBe(
      "andrew@alpha:instance:alpha-room",
    );
    expect(groupMemberKey({ ...alpha, generation: 9 })).toBe(
      groupMemberKey(alpha),
    );
    // A restarted omp has a new instance but keeps its ompc label.
    expect(
      groupMemberKey({ ...alpha, instanceId: "new-room", label: "mesh" }),
    ).toBe(groupMemberKey({ ...alpha, label: "mesh" }));
  });

  test("a grouped session stays in its group after its room is hosted again", () => {
    const groups = [
      { id: "g1", name: "Project", sessions: [groupMemberKey(alpha)] },
    ];
    const rehosted = { ...alpha, generation: alpha.generation + 1 };
    expect(groupSessions([rehosted], groups)[0]).toMatchObject({
      id: "g1",
      sessions: [rehosted],
    });
  });

  test("restores only a currently available remembered session", () => {
    expect(resolveRememberedSession([alpha, beta], sessionKey(alpha))).toEqual(
      alpha,
    );
    expect(resolveRememberedSession([beta], sessionKey(alpha))).toBeNull();
  });

  test("follows a remembered session to the room its process hosts now", () => {
    const rehosted = { ...alpha, generation: alpha.generation + 1 };
    expect(resolveRememberedSession([beta, rehosted], sessionKey(alpha))).toBe(
      rehosted,
    );
    const otherHost = { ...alpha, host_id: "andrew@gamma", generation: 3 };
    expect(
      resolveRememberedSession([beta, otherHost], sessionKey(alpha)),
    ).toBeNull();
  });

  test("chooses the advertised maximum access for a new selection", () => {
    expect(defaultRequestedAccess(alpha)).toBe("control");
    expect(defaultRequestedAccess(beta)).toBe("view");
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
      selected: sessionKey(alpha),
      inspector: "files",
    });
    expect(readWorkspace(storage)).toEqual({
      version: 1,
      selected: sessionKey(alpha),
      inspector: "files",
    });
    expect(JSON.parse(storage.value ?? "")).not.toHaveProperty("groups");
  });

  test("keeps legacy groups in storage until they are dropped", () => {
    const storage = new MemoryStorage();
    const legacy = [
      { id: "g1", name: "Project", sessions: [sessionKey(alpha)] },
    ];
    storage.value = JSON.stringify({
      version: 1,
      groups: [...legacy, { id: 3 }],
      selected: null,
      inspector: "session",
    });
    expect(readLegacyGroups(storage)).toEqual(legacy);
    writeWorkspace(storage, {
      version: 1,
      selected: sessionKey(beta),
      inspector: "files",
    });
    expect(readLegacyGroups(storage)).toEqual(legacy);
    dropLegacyGroups(storage);
    expect(readLegacyGroups(storage)).toEqual([]);
    expect(readWorkspace(storage)).toEqual({
      version: 1,
      selected: sessionKey(beta),
      inspector: "files",
    });
  });

  test("translates legacy room keys to member keys and drops unknown ones", () => {
    const named = { ...alpha, label: "mesh", generation: 5 };
    expect(
      legacyGroupsForImport(
        [
          {
            id: "g1",
            name: "  Project  ",
            sessions: [
              sessionKey(alpha),
              sessionKey({ ...alpha, generation: 4 }),
              sessionKey(beta),
              "andrew@gone:room:1",
            ],
          },
          { id: "g2", name: " ", sessions: [] },
        ],
        [named, beta],
      ),
    ).toEqual([
      {
        name: "Project",
        sessions: ["andrew@alpha:label:mesh", "andrew@beta:instance:beta-room"],
      },
      { name: "Group", sessions: [] },
    ]);
  });

  test("INSPECTOR_PANES lists agents before model roles", () => {
    expect(INSPECTOR_PANES.indexOf("agents")).toBeGreaterThanOrEqual(0);
    expect(INSPECTOR_PANES.indexOf("agents")).toBeLessThan(
      INSPECTOR_PANES.indexOf("models"),
    );
  });

  test("round-trips the model roles inspector pane through storage", () => {
    const storage = new MemoryStorage();
    writeWorkspace(storage, {
      version: 1,
      selected: null,
      inspector: "models",
    });
    expect(readWorkspace(storage).inspector).toBe("models");
  });

  test("round-trips the agents inspector pane through storage", () => {
    const storage = new MemoryStorage();
    writeWorkspace(storage, {
      version: 1,
      selected: null,
      inspector: "agents",
    });
    expect(readWorkspace(storage).inspector).toBe("agents");
  });

  test("falls back to the default inspector pane for an unknown stored value", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      version: 1,
      groups: [],
      selected: null,
      inspector: "not-a-real-pane",
    });
    expect(readWorkspace(storage).inspector).toBe("session");
  });

  test("maps the retired controls and participants panes to session", () => {
    const storage = new MemoryStorage();
    for (const legacy of ["controls", "participants"]) {
      storage.value = JSON.stringify({
        version: 1,
        groups: [],
        selected: null,
        inspector: legacy,
      });
      expect(readWorkspace(storage).inspector).toBe("session");
    }
  });

  test("falls back to defaults on corrupt storage", () => {
    const storage = new MemoryStorage();
    storage.value = "not json";
    expect(readWorkspace(storage)).toEqual({
      version: 1,
      selected: null,
      inspector: "session",
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

  test("prefers the hub-registered ompc label over the directory basename", () => {
    expect(
      sessionLabel({
        ...alpha,
        cwd: "/home/andrew/studio/mesh",
        label: "mesh.install",
      }),
    ).toBe("mesh.install");
  });

  test("falls back to verbose name then instance id without a cwd", () => {
    expect(
      sessionLabel({ ...alpha, sessionName: "Support multiple providers" }),
    ).toBe("Support multiple providers");
    expect(sessionLabel(alpha)).toBe(alpha.instanceId);
  });
});
