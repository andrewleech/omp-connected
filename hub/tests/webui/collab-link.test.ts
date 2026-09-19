import { describe, expect, test } from "bun:test";
import { collabFrameUrl } from "@/webui/lib/collab-link";

describe("collabFrameUrl", () => {
  test("passes a brokered capability only as the vendored guest fragment", () => {
    const frameUrl = collabFrameUrl(
      "https://relay.example/#room.key.write-token",
      "https://hub.example",
    );
    expect(frameUrl).toBe("https://hub.example/collab/#room.key.write-token");
    expect(new URL(frameUrl).search).toBe("");
  });

  test("rejects a link without a fragment", () => {
    expect(() =>
      collabFrameUrl("https://relay.example/room", "https://hub.example"),
    ).toThrow(/fragment/);
  });
});