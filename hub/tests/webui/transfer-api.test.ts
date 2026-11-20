import { describe, expect, test } from "bun:test";
import {
  type FetchLike,
  MAX_LISTED_ENTRIES,
  TransferApiError,
  createTransferApi,
  parsePlanResult,
  retryAfterMs,
  transferErrorKind,
  transferErrorMessage,
} from "@/webui/lib/transfer-api";

interface Call {
  url: string;
  method: string;
  body: unknown;
  cache: RequestCache | undefined;
  contentType: string | undefined;
}

function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake fetch answering from `responses` in order and recording each call. */
function fakeFetch(...responses: (Response | Error)[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      cache: init?.cache,
      contentType: (init?.headers as Record<string, string> | undefined)?.[
        "content-type"
      ],
    });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const RAW_PLAN = {
  planId: "plan-1",
  digest: "digest-1",
  plan: {
    mode: "update",
    entries: [
      { path: "a.txt", action: "add", kind: "file", bytes: 5 },
      { path: "b.txt", action: "replace", kind: "file", bytes: 7 },
      { path: "c.sh", action: "mode-change", kind: "file", bytes: 0 },
    ],
    unchanged: 4,
    destinationOnly: 2,
    conflicts: [],
    totalBytes: 12,
    warnings: [
      { kind: "possible-secret-file", path: ".env" },
      { kind: "submodule", path: "vendor/lib", detail: "not copied" },
    ],
    digest: "project-digest",
  },
  preflight: {
    sourceProject: "/home/user/project",
    destinationProject: "/home/user/project",
    destinationExists: true,
    sessionId: "session-1",
    title: "Fix the build",
    launcherName: "project.review",
    children: 2,
    archiveBytes: 4096,
    missingBlobs: ["blob-1"],
    externalReferences: ["/home/user/other.jsonl"],
    skippedSymlinks: [],
    gitDirty: true,
    knownUsers: ["editor (pid 12)"],
    warnings: ["model not configured"],
    blockers: [],
    runtimeVersion: "1.2.3",
    runtimeCompatible: true,
  },
};

describe("parsePlanResult", () => {
  test("normalises plan and preflight for display", () => {
    const view = parsePlanResult(RAW_PLAN);
    expect(view.planId).toBe("plan-1");
    expect(view.digest).toBe("digest-1");
    expect(view.mode).toBe("update");
    expect(view.project.adds).toBe(1);
    expect(view.project.replacements).toBe(1);
    expect(view.project.modeChanges).toBe(1);
    expect(view.project.destinationOnly).toBe(2);
    expect(view.project.unchanged).toBe(4);
    expect(view.project.secretFiles).toEqual([".env"]);
    expect(view.project.warnings).toHaveLength(2);
    expect(view.project.warnings[1]).toEqual({
      kind: "submodule",
      path: "vendor/lib",
      detail: "not copied",
    });
    expect(view.destinationExists).toBe(true);
    expect(view.sourceProject).toBe("/home/user/project");
    expect(view.launcherName).toBe("project.review");
    expect(view.children).toBe(2);
    expect(view.archiveBytes).toBe(4096);
    expect(view.missingBlobs).toEqual(["blob-1"]);
    expect(view.externalReferences).toEqual(["/home/user/other.jsonl"]);
    expect(view.gitDirty).toBe(true);
    expect(view.knownUsers).toEqual(["editor (pid 12)"]);
    expect(view.runtimeCompatible).toBe(true);
  });

  test("caps the listed entries but counts every one", () => {
    const entries = Array.from({ length: MAX_LISTED_ENTRIES + 50 }, (_, i) => ({
      path: `f${i}`,
      action: "add",
      kind: "file",
      bytes: 1,
    }));
    const view = parsePlanResult({
      planId: "p",
      digest: "d",
      plan: { mode: "create", entries },
      preflight: {},
    });
    expect(view.project.entries).toHaveLength(MAX_LISTED_ENTRIES);
    expect(view.project.entriesOmitted).toBe(50);
    expect(view.project.adds).toBe(MAX_LISTED_ENTRIES + 50);
  });

  test("destination existence falls back to the plan mode", () => {
    const base = { planId: "p", digest: "d", preflight: {} };
    expect(
      parsePlanResult({ ...base, plan: { mode: "create" } }).destinationExists,
    ).toBe(false);
    expect(
      parsePlanResult({ ...base, plan: { mode: "session-only" } })
        .destinationExists,
    ).toBe(true);
  });

  test("tolerates missing preflight fields", () => {
    const view = parsePlanResult({
      planId: "p",
      digest: "d",
      plan: { mode: "create" },
    });
    expect(view.children).toBeNull();
    expect(view.archiveBytes).toBeNull();
    expect(view.gitDirty).toBeNull();
    expect(view.runtimeCompatible).toBeNull();
    expect(view.missingBlobs).toEqual([]);
    expect(view.blockers).toEqual([]);
  });

  test("a plan without id, digest or a known mode cannot be committed", () => {
    for (const raw of [
      null,
      {},
      { planId: "p", plan: { mode: "create" } },
      { digest: "d", plan: { mode: "create" } },
      { planId: "p", digest: "d", plan: { mode: "mirror" } },
      { planId: "p", digest: "d" },
    ]) {
      let error: unknown;
      try {
        parsePlanResult(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TransferApiError);
      expect((error as TransferApiError).kind).toBe("invalid");
    }
  });
});

describe("transfer API requests", () => {
  test("destinations posts an empty object to the session route", async () => {
    const { fetch, calls } = fakeFetch(
      json({
        enabled: true,
        destinations: [
          { name: "worker", hostId: "user@worker-host" },
          { name: "", hostId: "ignored" },
        ],
      }),
    );
    const result = await createTransferApi(fetch).destinations(
      "hub/host",
      "i 1",
    );
    expect(result).toEqual({
      enabled: true,
      destinations: [{ name: "worker", hostId: "user@worker-host" }],
    });
    expect(calls).toEqual([
      {
        url: "/api/hosts/hub%2Fhost/sessions/i%201/transfer/destinations",
        method: "POST",
        body: {},
        cache: "no-store",
        contentType: "application/json",
      },
    ]);
  });

  test("a non-object destinations answer reads as disabled", async () => {
    const { fetch } = fakeFetch(json(null));
    expect(await createTransferApi(fetch).destinations("h", "i")).toEqual({
      enabled: false,
      destinations: [],
    });
  });

  test("plan sends only the fields it was given", async () => {
    const { fetch, calls } = fakeFetch(json(RAW_PLAN), json(RAW_PLAN));
    const api = createTransferApi(fetch);
    await api.plan("h", "i", { destination: "worker" });
    await api.plan("h", "i", {
      destination: "worker",
      projectMode: "update",
      destinationPath: "/home/user/elsewhere",
    });
    expect(calls[0]?.url).toBe("/api/hosts/h/sessions/i/transfer/plan");
    expect(calls[0]?.body).toEqual({ destination: "worker" });
    expect(calls[1]?.body).toEqual({
      destination: "worker",
      projectMode: "update",
      destinationPath: "/home/user/elsewhere",
    });
  });

  test("plan returns the normalised view", async () => {
    const { fetch } = fakeFetch(json(RAW_PLAN));
    const view = await createTransferApi(fetch).plan("h", "i", {
      destination: "worker",
    });
    expect(view.planId).toBe("plan-1");
    expect(view.project.adds).toBe(1);
  });

  test("commit body carries destination, plan binding, mode and the incomplete decision", async () => {
    const { fetch, calls } = fakeFetch(json({ operationId: "op-1" }));
    const result = await createTransferApi(fetch).commit("h", "i", {
      destination: "worker",
      planId: "plan-1",
      planDigest: "digest-1",
      projectMode: "session-only",
      acceptIncomplete: true,
    });
    expect(result).toEqual({ operationId: "op-1" });
    expect(calls[0]?.url).toBe("/api/hosts/h/sessions/i/transfer/commit");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      destination: "worker",
      planId: "plan-1",
      planDigest: "digest-1",
      projectMode: "session-only",
      acceptIncomplete: true,
    });
  });

  test("commit without an operation id is an invalid answer", async () => {
    const { fetch } = fakeFetch(json({}));
    const error = await createTransferApi(fetch)
      .commit("h", "i", {
        destination: "worker",
        planId: "p",
        planDigest: "d",
        projectMode: "create",
        acceptIncomplete: false,
      })
      .catch((caught: TransferApiError) => caught);
    expect((error as TransferApiError).kind).toBe("invalid");
  });

  test("list, get, cancel and recover use the operation routes", async () => {
    const view = { id: "op/1" };
    const { fetch, calls } = fakeFetch(
      json([view]),
      json(view),
      json(view),
      json(view),
    );
    const api = createTransferApi(fetch);
    await api.list();
    await api.get("op/1");
    await api.cancel("op/1");
    await api.recover("op/1", "retry-launch");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", "/api/transfers", undefined],
      ["GET", "/api/transfers/op%2F1", undefined],
      ["POST", "/api/transfers/op%2F1/cancel", undefined],
      ["POST", "/api/transfers/op%2F1/recover", { action: "retry-launch" }],
    ]);
    expect(calls.every((c) => c.cache === "no-store")).toBe(true);
    expect(calls[2]?.contentType).toBeUndefined();
    expect(calls[3]?.contentType).toBe("application/json");
  });

  test("abandon posts to the abandon route without a body", async () => {
    const { fetch, calls } = fakeFetch(json({ id: "op/1" }));
    await createTransferApi(fetch).abandon("op/1");
    expect(calls).toEqual([
      {
        url: "/api/transfers/op%2F1/abandon",
        method: "POST",
        body: undefined,
        cache: "no-store",
        contentType: undefined,
      },
    ]);
  });

  test("abandon of an active worker is a 409 with the hub's message", async () => {
    const { fetch } = fakeFetch(
      json({ error: "transfer worker is still active" }, 409),
    );
    const error = await createTransferApi(fetch)
      .abandon("op-1")
      .catch((caught: TransferApiError) => caught);
    expect((error as TransferApiError).kind).toBe("duplicate");
    expect((error as TransferApiError).message).toBe(
      "transfer worker is still active",
    );
  });

  test("resume is sent as a recover action", async () => {
    const { fetch, calls } = fakeFetch(json({ id: "op-1" }));
    await createTransferApi(fetch).recover("op-1", "resume");
    expect(calls[0]?.url).toBe("/api/transfers/op-1/recover");
    expect(calls[0]?.body).toEqual({ action: "resume" });
  });

  test("a failed commit keeps the operation id the hub names", async () => {
    const { fetch } = fakeFetch(
      json({ error: "no reply; may have started", operationId: "op-9" }, 504),
    );
    const error = await createTransferApi(fetch)
      .commit("h", "i", {
        destination: "worker",
        planId: "p",
        planDigest: "d",
        projectMode: "create",
        acceptIncomplete: false,
      })
      .catch((caught: TransferApiError) => caught);
    expect((error as TransferApiError).kind).toBe("timeout");
    expect((error as TransferApiError).operationId).toBe("op-9");
  });

  test("the default fetch is read from the global at call time", async () => {
    const real = globalThis.fetch;
    const { fetch, calls } = fakeFetch(json([]));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      await createTransferApi().list();
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toHaveLength(1);
  });
});

describe("transfer API error mapping", () => {
  async function failure(
    response: Response | Error,
  ): Promise<TransferApiError> {
    const { fetch } = fakeFetch(response);
    return createTransferApi(fetch)
      .commit("h", "i", {
        destination: "worker",
        planId: "p",
        planDigest: "d",
        projectMode: "create",
        acceptIncomplete: false,
      })
      .then(
        () => {
          throw new Error("expected a failure");
        },
        (caught: TransferApiError) => caught,
      );
  }

  test("409 is a duplicate and keeps the hub's message", async () => {
    const error = await failure(
      json(
        { error: "transfer op-1 is already in progress for this session" },
        409,
      ),
    );
    expect(error).toBeInstanceOf(TransferApiError);
    expect(error.kind).toBe("duplicate");
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "transfer op-1 is already in progress for this session",
    );
  });

  test("501 is unsupported", async () => {
    const error = await failure(
      json({ error: "does not support session.transfer.v1" }, 501),
    );
    expect(error.kind).toBe("unsupported");
    expect(error.message).toContain("session.transfer.v1");
  });

  test("501 without a body still explains", async () => {
    const error = await failure(new Response("<html>", { status: 501 }));
    expect(error.kind).toBe("unsupported");
    expect(error.message).toContain("Restart");
  });

  test("429 reads Retry-After and says when to retry", async () => {
    const error = await failure(
      json({ error: "Rate limit" }, 429, { "retry-after": "3" }),
    );
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(3000);
    expect(error.message).toBe("Too many transfer requests. Try again in 3s.");
  });

  test("other statuses map to kinds", async () => {
    expect((await failure(json({ error: "x" }, 403))).kind).toBe("forbidden");
    expect((await failure(json({ error: "x" }, 404))).kind).toBe("not-found");
    expect((await failure(json({ error: "x" }, 400))).kind).toBe("invalid");
    expect((await failure(json({ error: "x" }, 504))).kind).toBe("timeout");
    expect((await failure(json({ error: "x" }, 502))).kind).toBe("server");
    expect((await failure(json({ error: "boom" }, 500))).message).toBe("boom");
  });

  test("a worker-readable code is preserved", async () => {
    const error = await failure(
      json({ error: "x", code: "token-expired" }, 401),
    );
    expect(error.code).toBe("token-expired");
  });

  test("a network failure is status 0, unreachable", async () => {
    const error = await failure(new TypeError("fetch failed"));
    expect(error.status).toBe(0);
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe("Hub unreachable");
  });
});

describe("error helpers", () => {
  test("transferErrorKind covers the documented statuses", () => {
    expect(transferErrorKind(0)).toBe("unreachable");
    expect(transferErrorKind(409)).toBe("duplicate");
    expect(transferErrorKind(501)).toBe("unsupported");
    expect(transferErrorKind(429)).toBe("rate-limited");
    expect(transferErrorKind(418)).toBe("server");
  });

  test("retryAfterMs reads seconds and HTTP dates", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("soon")).toBeUndefined();
    const now = Date.parse("2026-11-21T00:00:00Z");
    expect(retryAfterMs("Sat, 21 Nov 2026 00:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("Sat, 21 Nov 2026 00:00:00 GMT", now + 9000)).toBe(0);
  });

  test("a rate-limit message without a delay stays generic", () => {
    expect(transferErrorMessage("rate-limited", undefined)).toBe(
      "Too many transfer requests.",
    );
  });
});
