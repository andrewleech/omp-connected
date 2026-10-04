import { describe, expect, test } from "bun:test";
import {
  MAX_VIEW_BYTES,
  decodeText,
  opensInViewer,
  renderHtmlDocument,
  renderMarkdownDocument,
  resolveRelative,
  viewKind,
} from "../../src/webui/lib/file-view";

const images = {
  apiBase: "https://hub.test/api/hosts/h/sessions/s",
  dir: "docs",
};

describe("which files open in the viewer", () => {
  test("text, scripts and extensionless names do; binaries and big files do not", () => {
    expect(opensInViewer("README.md", 100)).toBe(true);
    expect(opensInViewer("run.sh", 100)).toBe(true);
    expect(opensInViewer("LICENSE", 100)).toBe(true);
    expect(opensInViewer(".gitignore", 100)).toBe(true);
    expect(opensInViewer("photo.PNG", 100)).toBe(false);
    expect(opensInViewer("firmware.uf2", 100)).toBe(false);
    expect(opensInViewer("log.txt", MAX_VIEW_BYTES + 1)).toBe(false);
    expect(opensInViewer("log.txt", MAX_VIEW_BYTES)).toBe(true);
  });

  test("only Markdown and HTML have a rendered form", () => {
    expect(viewKind("a.md")).toBe("markdown");
    expect(viewKind("A.MARKDOWN")).toBe("markdown");
    expect(viewKind("page.htm")).toBe("html");
    expect(viewKind("run.sh")).toBe("text");
    expect(viewKind("LICENSE")).toBe("text");
  });
});

describe("decodeText", () => {
  test("accepts UTF-8 and rejects NUL bytes and invalid sequences", () => {
    expect(decodeText(new TextEncoder().encode("héllo ✓").buffer)).toBe(
      "héllo ✓",
    );
    expect(decodeText(new Uint8Array([104, 0, 105]).buffer)).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]).buffer)).toBeNull();
    expect(decodeText(new ArrayBuffer(0))).toBe("");
  });
});

describe("resolveRelative", () => {
  test("resolves against the directory and refuses to leave the session root", () => {
    expect(resolveRelative("docs", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveRelative("docs", "../a.png")).toBe("a.png");
    expect(resolveRelative("docs", "./a%20b.png?x=1#y")).toBe("docs/a b.png");
    expect(resolveRelative("docs", "/top.png")).toBe("top.png");
    expect(resolveRelative("docs", "../../a.png")).toBeNull();
    expect(resolveRelative("", "../a.png")).toBeNull();
    expect(resolveRelative("docs", "https://x.test/a.png")).toBeNull();
    expect(resolveRelative("docs", "//x.test/a.png")).toBeNull();
    expect(resolveRelative("docs", "#frag")).toBeNull();
  });
});

describe("renderMarkdownDocument", () => {
  test("renders GitHub-style Markdown and restricts what the document may load", () => {
    const doc = renderMarkdownDocument(
      "# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\necho hi\n```\n",
      "n.md",
      images,
    );
    expect(doc).toContain("<h1>T</h1>");
    expect(doc).toContain("<table>");
    expect(doc).toContain("<pre><code");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src https://hub.test data:");
  });

  test("links: web links open a new tab, fragments stay, everything else is inert", () => {
    const doc = renderMarkdownDocument(
      "[w](https://e.test) [f](#top) [r](other.md) [j](javascript:alert(1))",
      "n.md",
      images,
    );
    expect(doc).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="https://e.test">w</a>',
    );
    expect(doc).toContain('<a href="#top">f</a>');
    expect(doc).not.toContain('href="other.md"');
    expect(doc).not.toContain("javascript:");
  });

  test("relative images load through the session file API; remote ones are dropped", () => {
    const doc = renderMarkdownDocument(
      "![a](pics/a.png) ![r](https://e.test/r.png)",
      "n.md",
      images,
    );
    expect(doc).toContain(
      'src="https://hub.test/api/hosts/h/sessions/s/files/download?path=docs%2Fpics%2Fa.png&amp;inline=1"',
    );
    expect(doc).not.toContain("e.test/r.png");
  });
});

describe("renderHtmlDocument", () => {
  const policy = "Content-Security-Policy";

  test("puts the policy inside <head>, or creates one, without disturbing the doctype", () => {
    const withHead = renderHtmlDocument(
      "<!doctype html><html><head><title>x</title></head><body>b</body></html>",
    );
    expect(withHead.startsWith("<!doctype html><html><head><meta")).toBe(true);
    expect(withHead).toContain(policy);

    const noHead = renderHtmlDocument(
      "<!doctype html><html><body>b</body></html>",
    );
    expect(noHead).toContain(`<html><head><meta http-equiv="${policy}"`);

    const fragment = renderHtmlDocument("<p>hi</p>");
    expect(fragment.startsWith("<meta")).toBe(true);
    expect(fragment.endsWith("<p>hi</p>")).toBe(true);

    const doctypeOnly = renderHtmlDocument("<!DOCTYPE html>\n<p>hi</p>");
    expect(doctypeOnly.startsWith("<!DOCTYPE html><meta")).toBe(true);
  });
});
