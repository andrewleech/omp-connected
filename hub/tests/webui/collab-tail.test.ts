import { describe, expect, test } from "bun:test";
import { activeBranchEntries } from "@/webui/lib/collab-tail";

const entries = [
  { id: "root", parentId: null, type: "message" },
  { id: "before-rewind", parentId: "root", type: "message" },
  { id: "abandoned", parentId: "before-rewind", type: "message" },
  { id: "after-rewind", parentId: "root", type: "message" },
];

describe("Collab tail active leaf", () => {
  test("leaf movement and a later append exclude the abandoned branch", () => {
    expect(
      activeBranchEntries(entries, "before-rewind")?.map((entry) => entry.id),
    ).toEqual(["root", "before-rewind"]);
    expect(
      activeBranchEntries(entries, "after-rewind")?.map((entry) => entry.id),
    ).toEqual(["root", "after-rewind"]);
  });

  test("a null host leaf displays an empty transcript", () => {
    expect(activeBranchEntries(entries, null)).toEqual([]);
  });

  test("a missing leaf is not mistaken for an older host", () => {
    expect(activeBranchEntries(entries, "not-received")).toBeNull();
  });

  test("an omitted leaf preserves legacy unbranched rendering", () => {
    expect(
      activeBranchEntries(entries, undefined)?.map((entry) => entry.id),
    ).toEqual(["root", "before-rewind", "abandoned", "after-rewind"]);
  });

  test("a truncated tail keeps the buffered part of the active branch", () => {
    const tail = [
      { id: "tail-parent", parentId: "outside-buffer", type: "message" },
      { id: "other-branch", parentId: "outside-buffer", type: "message" },
      { id: "tail-leaf", parentId: "tail-parent", type: "message" },
    ];
    expect(
      activeBranchEntries(tail, "tail-leaf")?.map((entry) => entry.id),
    ).toEqual(["tail-parent", "tail-leaf"]);
  });

  test("a cyclic parent chain is unavailable", () => {
    expect(
      activeBranchEntries(
        [
          { id: "cycle-a", parentId: "cycle-b", type: "message" },
          { id: "cycle-b", parentId: "cycle-a", type: "message" },
        ],
        "cycle-b",
      ),
    ).toBeNull();
  });
});
