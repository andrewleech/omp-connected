import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createSessionRpc, supportsModelRoles, type AccessSource } from "../../src/session-rpc.js";

const configuration = {
  storage: "project" as const,
  roles: [{
    id: "default",
    name: "Default",
    selector: "openai/gpt-5",
    provenance: "project",
    globalSelector: null,
    projectSelector: "openai/gpt-5",
    resolvedModel: { provider: "openai", id: "gpt-5", name: "GPT-5" },
    models: [{ provider: "openai", id: "gpt-5", name: "GPT-5", thinkingLevels: ["off", "high"] }],
  }],
};

function createHarness(access: "view" | "control", context: unknown = { models: {} }) {
  const getAccess: AccessSource = { current: async () => access, refresh: async () => access };
  const rpc = createSessionRpc({
    pi: {} as never,
    context: () => context as ExtensionContext,
    access: getAccess,
    files: {} as never,
    scheduler: {} as never,
    forkCurrentSession: async () => ({ ok: true, label: "project.fork" }),
  });
  return { rpc };
}

describe("session model roles RPC", () => {
  test("reads role metadata on a view share", async () => {
    const ctx = { models: { roles: async () => configuration, setRole: async () => configuration } };
    const { rpc } = createHarness("view", ctx);
    await expect(rpc("session.model_roles", {})).resolves.toEqual({ ...configuration, access: "view" });
  });

  test("rejects writes on a view share before calling the OMP API", async () => {
    let writes = 0;
    const ctx = { models: { roles: async () => configuration, setRole: async () => { writes++; return configuration; } } };
    const { rpc } = createHarness("view", ctx);
    await expect(rpc("session.set_model_role", { role: "default", selector: null })).rejects.toMatchObject({ code: -32003 });
    expect(writes).toBe(0);
  });

  test("persists control-share writes and returns fresh configuration", async () => {
    const writes: unknown[][] = [];
    const ctx = { models: {
      roles: async () => configuration,
      setRole: async (...args: unknown[]) => { writes.push(args); return configuration; },
    } };
    const { rpc } = createHarness("control", ctx);
    await expect(rpc("session.set_model_role", { role: "default", selector: null, scope: "project" }))
      .resolves.toEqual({ ...configuration, access: "control" });
    expect(writes).toEqual([["default", null, "project"]]);
  });

  test("reports unsupported runtimes and validates malformed writes", async () => {
    expect(supportsModelRoles({ models: {} } as ExtensionContext)).toBe(false);
    expect(supportsModelRoles({ models: { roles() {}, setRole() {} } } as unknown as ExtensionContext)).toBe(true);
    const rpc = createHarness("control").rpc;
    await expect(rpc("session.model_roles", {})).rejects.toMatchObject({ code: -32601 });
    const ctx = { models: { roles: async () => configuration, setRole: async () => configuration } };
    const supported = createHarness("control", ctx).rpc;
    await expect(supported("session.set_model_role", { role: "default", selector: 7 }))
      .rejects.toMatchObject({ code: -32004 });
  });
  test("maps core API validation errors to RPC error codes", async () => {
    const invalid = Object.assign(new Error("invalid model selector"), { code: "invalid_selector" });
    const unknown = Object.assign(new Error("unknown role"), { code: "unknown_role" });
    const ctx = { models: {
      roles: async () => configuration,
      setRole: async (_role: string, selector: string | null) => {
        throw selector === "missing" ? unknown : invalid;
      },
    } };
    const rpc = createHarness("control", ctx).rpc;
    await expect(rpc("session.set_model_role", { role: "default", selector: "bad" }))
      .rejects.toMatchObject({ code: -32004 });
    await expect(rpc("session.set_model_role", { role: "missing", selector: "missing" }))
      .rejects.toMatchObject({ code: -32001 });
  });
});
