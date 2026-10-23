import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  authApi,
  isLoginActive,
  isSafeLoginLink,
  supportsAuth,
} from "@/webui/lib/session-api";
import { inspectorPaneFromStorage } from "@/webui/lib/workspace";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  cache: RequestCache | undefined;
}

function stubFetch(response: Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      cache: init?.cache,
    });
    return response.clone();
  }) as typeof fetch;
  return calls;
}

describe("authApi", () => {
  const api = authApi("/api/hosts/h1/sessions/s1");

  test("maps each operation to its route without caching", async () => {
    const calls = stubFetch(Response.json({ ok: true }));
    await api.list();
    await api.startLogin("anthropic");
    await api.loginStatus("login/1");
    await api.submitInput("login/1", "code");
    await api.cancelLogin("login/1");
    await api.logout("open router", 7);
    expect(calls).toEqual([
      {
        url: "/api/hosts/h1/sessions/s1/auth",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/api/hosts/h1/sessions/s1/auth/logins",
        method: "POST",
        body: { providerId: "anthropic" },
        cache: "no-store",
      },
      {
        url: "/api/hosts/h1/sessions/s1/auth/logins/login%2F1",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/api/hosts/h1/sessions/s1/auth/logins/login%2F1/input",
        method: "POST",
        body: { value: "code" },
        cache: "no-store",
      },
      {
        url: "/api/hosts/h1/sessions/s1/auth/logins/login%2F1",
        method: "DELETE",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/api/hosts/h1/sessions/s1/auth/accounts/open%20router/7",
        method: "DELETE",
        body: undefined,
        cache: "no-store",
      },
    ]);
  });

  test("hub errors surface as ApiError with the hub's message and status", async () => {
    stubFetch(Response.json({ error: "login in flight" }, { status: 409 }));
    const error = await api.startLogin("anthropic").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("login in flight");
    expect((error as ApiError).status).toBe(409);
  });
});

describe("login helpers", () => {
  test("only unfinished states keep polling", () => {
    for (const state of [
      "starting",
      "awaiting_auth",
      "awaiting_input",
    ] as const)
      expect(isLoginActive({ state })).toBe(true);
    for (const state of ["done", "failed", "cancelled"] as const)
      expect(isLoginActive({ state })).toBe(false);
  });

  test("only http(s) links are safe to open", () => {
    expect(isSafeLoginLink("https://auth.example.com/a?b=c")).toBe(true);
    expect(isSafeLoginLink("http://localhost:1455/callback")).toBe(true);
    expect(isSafeLoginLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLoginLink("data:text/html,x")).toBe(false);
    expect(isSafeLoginLink("not a url")).toBe(false);
  });

  test("the feature is read from the session's advertised features", () => {
    expect(supportsAuth({ features: ["session.v1", "session.auth.v1"] })).toBe(
      true,
    );
    expect(supportsAuth({ features: ["session.v1"] })).toBe(false);
    expect(supportsAuth({})).toBe(false);
  });

  test("the Login pane survives a stored-workspace round trip", () => {
    expect(inspectorPaneFromStorage("auth")).toBe("auth");
  });
});
