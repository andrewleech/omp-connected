import { describe, expect, test } from "bun:test";
import {
  buildShareUrl,
  labelSuffix,
  matchSession,
  parseShareUrl,
} from "../../src/webui/lib/share-link";

const sessions = [
  { instanceId: "a", sessionId: "s1", label: "proj", cwd: "/w/proj" },
  { instanceId: "b", sessionId: "s2", label: "proj.review", cwd: "/w/proj" },
];

describe("share links", () => {
  test("round-trips through the URL", () => {
    const target = {
      host: "me@box",
      instance: "a",
      sessionId: "s1",
      cwd: "/w/proj",
      label: "proj",
    };
    const url = new URL(buildShareUrl("https://hub.example", target));
    expect(url.pathname).toBe("/s/");
    expect(parseShareUrl(url.search)).toEqual(target);
  });

  test("needs a host", () => {
    expect(parseShareUrl("?i=a")).toBeNull();
  });

  test("instance id wins, then conversation, then label", () => {
    expect(
      matchSession(sessions, { host: "h", instance: "b", sessionId: "s1" })
        ?.instanceId,
    ).toBe("b");
    expect(
      matchSession(sessions, { host: "h", instance: "gone", sessionId: "s2" })
        ?.instanceId,
    ).toBe("b");
    expect(
      matchSession(sessions, { host: "h", instance: "gone", label: "proj" })
        ?.instanceId,
    ).toBe("a");
  });

  test("ambiguous or unknown targets do not match", () => {
    const dup = [
      ...sessions,
      { instanceId: "c", sessionId: "s2", label: "x", cwd: "/o" },
    ];
    expect(matchSession(dup, { host: "h", sessionId: "s2" })).toBeUndefined();
    expect(
      matchSession(sessions, { host: "h", label: "proj", cwd: "/elsewhere" }),
    ).toBeUndefined();
    expect(
      matchSession(sessions, { host: "h", instance: "gone" }),
    ).toBeUndefined();
  });

  test("label suffix is relative to the cwd basename", () => {
    expect(labelSuffix("proj.review", "/w/proj")).toBe("review");
    expect(labelSuffix("proj", "/w/proj")).toBe("");
    expect(labelSuffix(undefined, "/w/proj")).toBe("");
  });
});
