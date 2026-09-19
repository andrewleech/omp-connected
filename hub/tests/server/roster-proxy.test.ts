import { afterEach, describe, expect, test } from "bun:test";
import { RosterProxy } from "@/server/roster-proxy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RosterProxy", () => {
  test("disabled when no claude-net origin is configured", async () => {
    const roster = new RosterProxy(undefined);
    expect(roster.enabled).toBe(false);
    await expect(roster.listAgents()).rejects.toThrow(/not configured/);
  });

  test("forwards GET calls to the configured claude-net origin and caches briefly", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      expect(String(input)).toBe("https://hub.example/api/agents");
      return new Response(
        JSON.stringify([{ fullName: "a@b", shortName: "a", status: "online" }]),
        { status: 200 },
      );
    }) as typeof fetch;

    const roster = new RosterProxy("https://hub.example");
    const first = await roster.listAgents();
    const second = await roster.listAgents();
    expect(first).toEqual([
      { fullName: "a@b", shortName: "a", status: "online" },
    ]);
    expect(second).toEqual(first);
    expect(calls).toBe(1); // second call served from the 4s cache
  });

  test("posts a message and surfaces a non-2xx claude-net response as an error", async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        to: "a@b",
        content: "hi",
      });
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const roster = new RosterProxy("https://hub.example");
    await expect(roster.sendAgentMessage("a@b", "hi")).rejects.toThrow(/500/);
  });

  test("allow() rate-limits by caller key independently of claude-net configuration", () => {
    const roster = new RosterProxy(undefined);
    for (let i = 0; i < 30; i++) expect(roster.allow("client-1")).toBe(true);
    expect(roster.allow("client-1")).toBe(false);
    expect(roster.allow("client-2")).toBe(true);
  });
});