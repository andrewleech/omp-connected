// Host-side customization of the same-origin vendored Collab guest, applied
// from the dashboard on every frame load so the upstream guest stays
// unpatched:
// - The guest sets `overscroll-behavior-y: none` on its root, which stops
//   overscroll chaining out of the iframe and so kills the browser's
//   pull-to-refresh; restore default chaining.
// - The composer textarea claims horizontal pans only, with its own overscroll
//   contained. With the guest's default `touch-action: manipulation` the
//   browser takes a downward swipe (pull-to-refresh / pan) and cancels the
//   pointer before the guest's history swipe sees it, so swipe down never
//   navigated back through prompt history. Drafts taller than the autosize
//   cap scroll vertically, so those keep `pan-y`.
// - The dashboard owns session selection, so hide the guest's own
//   "leave session" button.
// - Text selection gets an explicit high-contrast highlight, and the dark
//   theme's faint text is lightened for legibility.
// - Pinch over the guest scales the transcript text (CSS `zoom` on each
//   transcript row, so lines reflow) instead of zooming the whole page. The
//   scale persists across frames and reloads.

export const TEXT_SCALE_STORAGE_KEY = "omp-hub-dashboard/collab-text-scale";
const MIN_TEXT_SCALE = 0.6;
const MAX_TEXT_SCALE = 2.5;

const GUEST_CSS = `
html, body { overscroll-behavior-y: auto; touch-action: pan-x pan-y; }
.sh-composer-input { touch-action: pan-x; overscroll-behavior-y: contain; }
.sh-composer-input[style*="overflow-y: auto"] { touch-action: pan-y; }
.sh-header button[title="leave session"] { display: none; }
.tr-root > * { zoom: var(--omp-text-scale, 1); }
::selection { background: #8e2c6b; color: #fff; }
:root[data-theme="dark"] { --fg-faint: #9a9aa4; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { --fg-faint: #9a9aa4; } }
`;

/** Maps a same-origin relative guest link to a path in the session's file API. */
export function collabFilePathFromHref(
  href: string,
  pageUrl: string,
): string | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let page: URL;
  let target: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(href, page);
  } catch {
    return null;
  }
  const prefix = "/collab/";
  if (
    page.pathname !== prefix ||
    target.origin !== page.origin ||
    !target.pathname.startsWith(prefix)
  )
    return null;
  let path: string;
  try {
    path = decodeURIComponent(target.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  const segments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return null;
  return path;
}

export function attachCollabFileLinks(
  doc: Document,
  openFile: (path: string) => void,
): void {
  doc.addEventListener(
    "click",
    (event) => {
      const ElementType = doc.defaultView?.Element;
      if (!ElementType || !(event.target instanceof ElementType)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const path = collabFilePathFromHref(
        anchor.getAttribute("href") ?? "",
        doc.location.href,
      );
      if (path === null) return;
      event.preventDefault();
      openFile(path);
    },
    true,
  );
}

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, value));
}

// Callers only pass lists holding exactly two touches.
function touchDistance(touches: TouchList): number {
  const a = touches[0] as Touch;
  const b = touches[1] as Touch;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function customizeCollabFrame(doc: Document, storage: Storage): void {
  const style = doc.createElement("style");
  style.textContent = GUEST_CSS;
  doc.head.append(style);

  const docEl = doc.documentElement;
  let scale = clampTextScale(
    Number(storage.getItem(TEXT_SCALE_STORAGE_KEY) ?? 1),
  );
  docEl.style.setProperty("--omp-text-scale", String(scale));

  const setScale = (requested: number): void => {
    const next = clampTextScale(requested);
    if (next === scale) return;
    // Keep the reading position: stay pinned to the tail when following it,
    // otherwise keep the viewport's centre line in place.
    const scroller = doc.querySelector<HTMLElement>(".tr-root");
    const atTail =
      scroller !== null &&
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
    const centre =
      scroller !== null
        ? (scroller.scrollTop + scroller.clientHeight / 2) /
          scroller.scrollHeight
        : 0;
    scale = next;
    docEl.style.setProperty("--omp-text-scale", String(scale));
    if (scroller !== null)
      scroller.scrollTop = atTail
        ? scroller.scrollHeight
        : centre * scroller.scrollHeight - scroller.clientHeight / 2;
  };

  let pinch: { distance: number; scale: number } | null = null;
  const endPinch = (event: TouchEvent): void => {
    if (pinch === null || event.touches.length >= 2) return;
    pinch = null;
    storage.setItem(TEXT_SCALE_STORAGE_KEY, String(scale));
  };
  doc.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) return;
      const distance = touchDistance(event.touches);
      if (distance > 0) pinch = { distance, scale };
    },
    { passive: true },
  );
  doc.addEventListener(
    "touchmove",
    (event) => {
      if (pinch === null || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      setScale((pinch.scale * touchDistance(event.touches)) / pinch.distance);
    },
    { passive: false },
  );
  doc.addEventListener("touchend", endPinch);
  doc.addEventListener("touchcancel", endPinch);
  // iOS Safari zooms the page from its own gesture events, not touchmove.
  doc.addEventListener("gesturestart", (event) => event.preventDefault());
}

const MAX_TEMP_DROP_BYTES = 256 * 1024 * 1024;
const PROMPT_COMPOSER = ".sh-composer:not(.sh-composer-ask)";
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith("image/");
}

export interface UnsupportedDropOptions {
  apiBase: string;
  canUpload: () => boolean;
  onError: (message: string) => void;
}

/** Routes non-image drops in the embedded prompt through the host temp API. */
export function attachUnsupportedFileDrop(
  doc: Document,
  options: UnsupportedDropOptions,
): void {
  const upload = async (file: File): Promise<string> => {
    if (!options.canUpload())
      throw new Error("The selected session is no longer available.");
    if (file.size > MAX_TEMP_DROP_BYTES)
      throw new Error("File exceeds the 256 MiB upload limit.");
    const extension = file.name.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] ?? "";
    const path = `${crypto.randomUUID()}${extension}`;
    const response = await fetch(
      `${options.apiBase}/files/upload?path=${encodeURIComponent(path)}&overwrite=0&destination=temp`,
      { method: "PUT", body: file },
    );
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result !== "object")
      throw new Error(
        response.status === 413
          ? "File exceeds the 256 MiB upload limit."
          : "Host temp upload failed.",
      );
    if (
      !("ok" in result) ||
      result.ok !== true ||
      !("path" in result) ||
      typeof result.path !== "string" ||
      !("size" in result) ||
      result.size !== file.size ||
      result.path.length > 4096 ||
      !(
        result.path.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(result.path) ||
        result.path.startsWith("\\\\")
      ) ||
      hasControlCharacters(result.path) ||
      result.path.trim() !== result.path ||
      result.path.endsWith("/") ||
      result.path.endsWith("\\") ||
      result.path.split(/[\\/]/).some((part) => part === "." || part === "..")
    )
      throw new Error("Host returned an invalid temp upload result.");
    return result.path;
  };
  const isComposerEvent = (event: DragEvent): boolean => {
    const view = doc.defaultView;
    return (
      view !== null &&
      event.target instanceof view.Element &&
      event.target.closest(PROMPT_COMPOSER) !== null
    );
  };
  const insertPaths = (paths: string[]): void => {
    const input = doc.querySelector<HTMLTextAreaElement>(
      `${PROMPT_COMPOSER} .sh-composer-input`,
    );
    if (!input || !options.canUpload()) return;
    const text = paths.join("\n");
    input.focus();
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const prefix =
      start > 0 && !/\s/.test(input.value[start - 1] ?? "") ? "\n" : "";
    const suffix =
      end < input.value.length && !/\s/.test(input.value[end] ?? "")
        ? "\n"
        : "";
    const insertion = `${prefix}${text}${suffix}`;
    const inserted = doc.execCommand("insertText", false, insertion);
    if (!inserted) {
      const value = input.value;
      const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
      const prototype = doc.defaultView?.HTMLTextAreaElement.prototype;
      const setter = prototype
        ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
        : undefined;
      if (setter) setter.call(input, next);
      else input.value = next;
      input.setSelectionRange(
        start + insertion.length,
        start + insertion.length,
      );
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: insertion,
        }),
      );
    }
  };
  const fileItems = (event: DragEvent): File[] =>
    [...(event.dataTransfer?.items ?? [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

  doc.addEventListener(
    "dragover",
    (event) => {
      if (!options.canUpload() || !isComposerEvent(event)) return;
      if (
        ![...(event.dataTransfer?.items ?? [])].some(
          (item) => item.kind === "file",
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  doc.addEventListener(
    "drop",
    (event) => {
      if (!options.canUpload() || !isComposerEvent(event)) return;
      const files = fileItems(event);
      const unsupported = files.filter((file) => !isImageFile(file));
      if (unsupported.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const images = files.filter(isImageFile);
      if (images.length > 0) {
        const view = doc.defaultView;
        const composer = doc.querySelector<HTMLElement>(PROMPT_COMPOSER);
        if (composer && view?.DataTransfer && view.DragEvent) {
          const transfer = new view.DataTransfer();
          for (const image of images) transfer.items.add(image);
          composer.dispatchEvent(
            new view.DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        }
      }
      void (async () => {
        const paths: string[] = [];
        const errors: string[] = [];
        for (const file of unsupported) {
          if (!options.canUpload()) return;
          try {
            paths.push(await upload(file));
          } catch (error) {
            errors.push(`${file.name}: ${(error as Error).message}`);
          }
        }
        if (!options.canUpload()) return;
        if (paths.length > 0) insertPaths(paths);
        if (errors.length > 0) options.onError(errors.join("\n"));
      })();
    },
    true,
  );
}
