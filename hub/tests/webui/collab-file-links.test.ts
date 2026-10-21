import { describe, expect, test } from "bun:test";
import {
  attachCollabFileLinks,
  collabFilePathFromHref,
} from "@/webui/lib/collab-frame";

const page = "https://hub.example/collab/#relay-capability";

describe("collabFilePathFromHref", () => {
  test("maps relative guest links to session-relative paths", () => {
    expect(
      collabFilePathFromHref(
        "cve-backfill/owner-review/2025-10-05_2026-10-05/review.html",
        page,
      ),
    ).toBe("cve-backfill/owner-review/2025-10-05_2026-10-05/review.html");
  });

  test("opens a relative link through the session file handler", () => {
    let onClick: ((event: MouseEvent) => void) | undefined;
    let opened = "";
    const link = {
      getAttribute: (name: string) =>
        name === "href" ? "cve-backfill/review.html" : null,
    };
    class Target {
      closest<T extends Element>(selector: string): T | null {
        return selector === "a[href]" ? (link as unknown as T) : null;
      }
    }
    const doc = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        onClick = listener as (event: MouseEvent) => void;
      },
      defaultView: { Element: Target },
      location: { href: page },
    } as unknown as Document;
    attachCollabFileLinks(doc, (path) => {
      opened = path;
    });

    const event: { defaultPrevented: boolean } & Record<string, unknown> = {
      target: new Target(),
      defaultPrevented: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    onClick?.(event as unknown as MouseEvent);
    expect(opened).toBe("cve-backfill/review.html");
    expect(event.defaultPrevented).toBe(true);
  });

  test("decodes URL-escaped path names", () => {
    expect(collabFilePathFromHref("reports/review%20copy.html", page)).toBe(
      "reports/review copy.html",
    );
  });

  test("leaves external links, fragments and other hub paths alone", () => {
    expect(
      collabFilePathFromHref("https://example.com/review.html", page),
    ).toBeNull();
    expect(collabFilePathFromHref("#summary", page)).toBeNull();
    expect(
      collabFilePathFromHref("/api/hosts/h/sessions/s/files", page),
    ).toBeNull();
  });

  test("rejects paths that escape the session folder or have invalid escapes", () => {
    expect(collabFilePathFromHref("../private.txt", page)).toBeNull();
    expect(collabFilePathFromHref("%2e%2e%2fprivate.txt", page)).toBeNull();
    expect(collabFilePathFromHref("%2fetc/passwd", page)).toBeNull();
    expect(collabFilePathFromHref("reports/%E0%A4%A.html", page)).toBeNull();
  });
});
