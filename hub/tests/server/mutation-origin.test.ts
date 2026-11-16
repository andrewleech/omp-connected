import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowsMutationOrigin, createHub } from "@/server/index";

const url = "http://hub.example/api/hosts/host/sessions/id/files/mkdir";

test("browser mutations require the hub origin", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of [
      "null",
      "http://evil.example",
      "http://hub.example.evil.example",
      "invalid",
    ]) {
      expect(
        allowsMutationOrigin(new Request(url, { method, headers: { origin } })),
      ).toBe(false);
    }
    expect(
      allowsMutationOrigin(
        new Request(url, { method, headers: { origin: "http://hub.example" } }),
      ),
    ).toBe(true);
    expect(
      allowsMutationOrigin(
        new Request(url, {
          method,
          headers: { origin: "https://public.example" },
        }),
        "https://public.example",
      ),
    ).toBe(true);
    expect(
      allowsMutationOrigin(
        new Request(url, {
          method,
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toBe(false);
    expect(allowsMutationOrigin(new Request(url, { method }))).toBe(true);
  }
  expect(
    allowsMutationOrigin(new Request(url, { headers: { origin: "null" } })),
  ).toBe(true);
});

test("WebSocket upgrades use the origin guard even on GET", () => {
  for (const origin of ["null", "http://evil.example", "invalid"]) {
    expect(
      allowsMutationOrigin(
        new Request(url, {
          headers: { upgrade: "websocket", origin },
        }),
      ),
    ).toBe(false);
  }
  for (const origin of ["http://hub.example", "https://public.example"]) {
    expect(
      allowsMutationOrigin(
        new Request(url, {
          headers: { upgrade: "WebSocket", origin },
        }),
        "https://public.example",
      ),
    ).toBe(true);
  }
  expect(
    allowsMutationOrigin(
      new Request(url, {
        headers: { upgrade: "websocket" },
      }),
    ),
  ).toBe(true);
  expect(
    allowsMutationOrigin(
      new Request(url, {
        headers: { upgrade: "websocket", "sec-fetch-site": "cross-site" },
      }),
    ),
  ).toBe(false);
});

function upgradeStatus(
  port: number,
  path: string,
  origin?: string,
): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  socket.on("error", reject);
  socket.on("connect", () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin === undefined ? "" : `Origin: ${origin}\r\n`}\r\n`,
    );
  });
  socket.on("data", (data) => {
    response += data.toString();
    const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
    if (match) {
      socket.destroy();
      resolve(Number(match[1]));
    }
  });
  socket.on("end", () =>
    reject(new Error("connection closed before upgrade response")),
  );
  return promise;
}

test("hub WebSocket routes reject cross-origin upgrades", async () => {
  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = reservation.port;
  reservation.stop();
  const stateDir = mkdtempSync(join(tmpdir(), "hub-ws-origin-test-"));
  const hub = createHub({ host: "127.0.0.1", port, stateDir, relay: false });
  try {
    for (const path of ["/ws/dashboard", "/ws/agent", "/ws/terminal/host"]) {
      for (const origin of ["null", "http://evil.example"]) {
        expect(await upgradeStatus(port, path, origin)).toBe(403);
      }
      expect(await upgradeStatus(port, path, `http://127.0.0.1:${port}`)).toBe(
        101,
      );
      expect(await upgradeStatus(port, path)).toBe(101);
    }
  } finally {
    hub.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the hub guards mutation routes before their handlers", async () => {
  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = reservation.port;
  reservation.stop();
  const stateDir = mkdtempSync(join(tmpdir(), "hub-origin-test-"));
  const hub = createHub({ host: "127.0.0.1", port, stateDir, relay: false });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const [method, path] of [
      ["POST", "/api/groups/"],
      ["POST", "/api/agents/test/send"],
      ["POST", "/api/hosts/test/sessions/id/exit"],
      ["PUT", "/api/hosts/test/sessions/id/files/upload?path=x"],
      ["DELETE", "/api/groups/test"],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { origin: "null", "content-type": "text/plain" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(response.status).toBe(403);
    }
    const allowed = await fetch(`${base}/api/groups/`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ name: "origin-test" }),
    });
    expect(allowed.status).toBe(200);
  } finally {
    hub.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
