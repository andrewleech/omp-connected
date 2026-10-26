import { webcrypto } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

const KEY = new Uint8Array(32).fill(7);
const KEY_B64 = Buffer.from(KEY).toString("base64url");
const ROOM_LINK = `ws://relay.test/r/fixtureroom01#${KEY_B64}`;

async function sealed(frame: Record<string, unknown>): Promise<Buffer> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(KEY),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(frame)),
    ),
  );
  // Relay envelope: 4-byte sender peer id (0 = host), then IV + ciphertext.
  return Buffer.concat([Buffer.alloc(4), Buffer.from(iv), Buffer.from(ct)]);
}

async function opened(data: string | Buffer): Promise<Record<string, unknown>> {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const key = await webcrypto.subtle.importKey("raw", KEY, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(bytes.subarray(4, 16)) },
    key,
    new Uint8Array(bytes.subarray(16)),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Fake host speaking `hostProto`: rejects other versions the way omp hosts
 *  do (error frame, guest stays connected) and records every hello. */
async function routeHost(
  page: Page,
  hostProto: number,
  hellos: number[],
): Promise<void> {
  await page.route("**/api/hosts/viewer/collab/*/link", (route) =>
    route.fulfill({ json: { access: "view", url: ROOM_LINK } }),
  );
  await page.routeWebSocket("ws://relay.test/r/**", (ws) => {
    ws.onMessage(async (data) => {
      const hello = await opened(data as Buffer);
      const proto = Number(hello.proto);
      hellos.push(proto);
      if (proto !== hostProto) {
        ws.send(
          await sealed({
            t: "error",
            message: `protocol mismatch: host speaks v${hostProto}, guest sent v${proto}`,
          }),
        );
        return;
      }
      ws.send(
        await sealed({
          t: "welcome",
          proto,
          header: {},
          state: {},
          agents: [],
          entryCount: 1,
          leafId: "a",
        }),
      );
      ws.send(
        await sealed({
          t: "snapshot-chunk",
          entries: [message("a", null, "from the old host")],
          final: true,
        }),
      );
    });
  });
}

test("the tail viewer joins a v3 host by resending its hello as v3", async ({
  page,
}) => {
  const hellos: number[] = [];
  await routeHost(page, 3, hellos);
  await page.goto("/");
  await page.getByRole("button", { name: "viewer view", exact: true }).click();
  await expect(page.locator(".tail-viewer")).toContainText("from the old host");
  expect(hellos).toEqual([4, 3]);
});

test("the tail viewer reports a host version it can't speak", async ({
  page,
}) => {
  const hellos: number[] = [];
  await routeHost(page, 2, hellos);
  await page.goto("/");
  await page.getByRole("button", { name: "viewer view", exact: true }).click();
  await expect(page.locator(".tail-viewer")).toContainText(
    "protocol mismatch: host speaks v2",
  );
  expect(hellos).toEqual([4]);
});

const message = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: text },
});

test("the tail viewer applies live entries after the snapshot they follow", async ({
  page,
}) => {
  let sendSnapshot: (() => Promise<void>) | undefined;
  await page.route("**/api/hosts/viewer/collab/*/link", (route) =>
    route.fulfill({ json: { access: "view", url: ROOM_LINK } }),
  );
  await page.routeWebSocket("ws://relay.test/r/**", (ws) => {
    sendSnapshot = async () => {
      ws.send(
        await sealed({
          t: "welcome",
          proto: 4,
          header: {},
          state: {},
          agents: [],
          entryCount: 2,
          leafId: "b",
        }),
      );
      ws.send(
        await sealed({
          t: "snapshot-chunk",
          entries: [message("a", null, "snapshot one")],
        }),
      );
      // The host sends live traffic ahead of the rest of the snapshot.
      ws.send(
        await sealed({ t: "entry", entry: message("c", "b", "live three") }),
      );
      ws.send(
        await sealed({
          t: "snapshot-chunk",
          entries: [message("b", "a", "snapshot two")],
          final: true,
        }),
      );
    };
    ws.onMessage(() => void sendSnapshot?.());
  });

  await page.goto("/");
  await page.getByRole("button", { name: "viewer view", exact: true }).click();
  const viewer = page.locator(".tail-viewer");
  const order = ["snapshot one", "snapshot two", "live three"];
  await expect(viewer).toContainText(order[2] ?? "");
  const text = (await viewer.textContent()) ?? "";
  const positions = order.map((entry) => text.indexOf(entry));
  expect(positions[0]).toBeGreaterThan(-1);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));

  // A second welcome is a resync: the fresh snapshot replaces the old one.
  await sendSnapshot?.();
  await expect(viewer.getByText("snapshot one")).toHaveCount(1);
  await expect(viewer.getByText("live three")).toHaveCount(1);
});
