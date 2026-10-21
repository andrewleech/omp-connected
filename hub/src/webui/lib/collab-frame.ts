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
