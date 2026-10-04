// Pure helpers behind the Files tab's text viewer: deciding which files open
// in it, decoding them, and building the sandboxed documents shown for the
// rendered view.
//
// File contents come from the session's machine, so nothing here may run
// them: the viewer shows every document in an iframe with an empty `sandbox`
// attribute (no scripts, opaque origin), and each document also carries a
// Content-Security-Policy that only allows inline styles and images.

import { marked } from "marked";
import { joinPath, normalisePath } from "./file-paths";

/** Larger files are offered as downloads only. */
export const MAX_VIEW_BYTES = 1024 * 1024;

export type ViewKind = "markdown" | "html" | "text";

const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif webp ico bmp tif tiff heic avif pdf zip gz tgz bz2 xz zst 7z rar tar " +
    "bin elf exe dll so o a obj lib dylib class jar war wasm pyc pyd whl " +
    "mp3 mp4 m4a mov avi mkv webm ogg wav flac woff woff2 ttf otf eot " +
    "sqlite sqlite3 db iso img dmg apk deb rpm uf2 hex dfu"
  ).split(" "),
);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How a file is shown: Markdown and HTML have a rendered form, the rest is text. */
export function viewKind(name: string): ViewKind {
  const ext = extension(name);
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "text";
}

/**
 * Whether a click on `name` should try the viewer. Only the name and size are
 * known at this point, so this rules out the obviously binary and the large;
 * the viewer still falls back to a download if the bytes are not text.
 */
export function opensInViewer(name: string, size: number): boolean {
  if (size > MAX_VIEW_BYTES) return false;
  return !BINARY_EXTENSIONS.has(extension(name));
}

/** The text of `bytes`, or null when it is not UTF-8 text (NUL bytes or invalid sequences). */
export function decodeText(bytes: ArrayBuffer): string | null {
  const view = new Uint8Array(bytes);
  if (view.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cspMeta(imageSources: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}">`;
}

const RENDERED_CSS = `
:root { color-scheme: dark; }
body { background: #0d1117; color: #e6edf3; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0 auto; max-width: 48em; padding: 1em; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #f0f6fc; margin: 1.5em 0 .5em; }
h1, h2 { border-bottom: 1px solid #30363d; padding-bottom: .3em; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: #161b22; border-radius: 6px; font-size: 85%; padding: .2em .4em; }
pre { background: #161b22; border-radius: 6px; overflow-x: auto; padding: 1em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #30363d; color: #8b949e; margin: 0; padding: .5em 1em; }
table { border-collapse: collapse; display: block; margin: 1em 0; overflow-x: auto; }
th, td { border: 1px solid #30363d; padding: .4em .8em; text-align: left; }
th { background: #161b22; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #30363d; margin: 2em 0; }
`;

/** Where a Markdown document's relative images are fetched from. */
export interface ImageSource {
  /** Absolute origin plus the session API prefix, with no trailing slash. */
  apiBase: string;
  /** Directory of the Markdown file, relative to the session root. */
  dir: string;
}

/**
 * Resolves `href` against `dir` the way a browser would for a relative URL,
 * returning the session-root-relative path, or null when it is absolute,
 * protocol-relative, or climbs out of the root.
 */
export function resolveRelative(dir: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const pathPart = href.split(/[?#]/, 1)[0] ?? "";
  if (pathPart === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  const segments = (
    decoded.startsWith("/") ? [] : normalisePath(dir).split("/")
  ).filter(Boolean);
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length ? joinPath("", segments.join("/")) : null;
}

/** A complete, self-contained document for the rendered view of Markdown. */
export function renderMarkdownDocument(
  text: string,
  title: string,
  images: ImageSource,
): string {
  const renderer = new marked.Renderer();
  const defaultLink = renderer.link.bind(renderer);
  renderer.link = (token) => {
    const href = token.href ?? "";
    // Fragments stay in the page; web links open in a new tab; anything else
    // (relative paths, javascript:, data:) has nowhere safe to go.
    if (href.startsWith("#")) return defaultLink(token);
    if (/^https?:\/\//i.test(href)) {
      const html = defaultLink(token);
      return html.replace(
        /^<a /,
        '<a target="_blank" rel="noopener noreferrer" ',
      );
    }
    return `<span>${renderer.parser.parseInline(token.tokens)}</span>`;
  };
  renderer.image = ({ href, text: alt, title: imageTitle }) => {
    const relative = resolveRelative(images.dir, href ?? "");
    const src = relative
      ? `${images.apiBase}/files/download?path=${encodeURIComponent(relative)}&inline=1`
      : /^data:image\//i.test(href ?? "")
        ? href
        : null;
    if (!src) return escapeHtml(alt);
    const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : "";
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr}>`;
  };
  const body = marked.parse(text, {
    async: false,
    gfm: true,
    renderer,
  }) as string;
  const origin = new URL(images.apiBase).origin;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${cspMeta(`${origin} data:`)}<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${RENDERED_CSS}</style></head><body>${body}</body></html>`;
}

/**
 * The HTML file itself with a restrictive policy added, so it renders as it
 * would in a browser without running script or loading anything remote.
 */
export function renderHtmlDocument(text: string): string {
  const meta = cspMeta("data:");
  const head = /<head(\s[^>]*)?>/i.exec(text);
  if (head) {
    const at = head.index + head[0].length;
    return text.slice(0, at) + meta + text.slice(at);
  }
  const html = /<html(\s[^>]*)?>/i.exec(text);
  if (html) {
    const at = html.index + html[0].length;
    return `${text.slice(0, at)}<head>${meta}</head>${text.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  const at = doctype ? doctype[0].length : 0;
  return text.slice(0, at) + meta + text.slice(at);
}
