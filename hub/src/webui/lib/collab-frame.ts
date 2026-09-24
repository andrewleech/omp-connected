// Host-side customization of the same-origin vendored Collab guest, applied
// from the dashboard on every frame load so the upstream guest stays
// unpatched:
// - The guest sets `overscroll-behavior-y: none` on its root, which stops
//   overscroll chaining out of the iframe and so kills the browser's
//   pull-to-refresh; restore default chaining.
// - The dashboard owns session selection, so hide the guest's own
//   "leave session" button.
// - Pinch over the guest scales the transcript text (CSS `zoom` on each
//   transcript row, so lines reflow) instead of zooming the whole page. The
//   scale persists across frames and reloads.

export const TEXT_SCALE_STORAGE_KEY = "omp-hub-dashboard/collab-text-scale";
const MIN_TEXT_SCALE = 0.6;
const MAX_TEXT_SCALE = 2.5;

const GUEST_CSS = `
html, body { overscroll-behavior-y: auto; touch-action: pan-x pan-y; }
.sh-header button[title="leave session"] { display: none; }
.tr-root > * { zoom: var(--omp-text-scale, 1); }
`;

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
