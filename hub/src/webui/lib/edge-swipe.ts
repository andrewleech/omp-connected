// One-finger horizontal swipes for the compact layout's drawers: from a
// screen edge inward opens that side's drawer; back toward the edge closes
// an open one. Listeners go on both the dashboard document and the
// same-origin Collab guest document, since touches over the iframe never
// reach the outer page.

export type SwipeAction =
  | "open-left"
  | "open-right"
  | "close-left"
  | "close-right";

export interface DrawerState {
  left: boolean;
  right: boolean;
}

// Edge band wide enough to start in, but gestures starting at the very edge
// are usually taken by the OS/browser back gesture first.
const EDGE_PX = 32;
const TRIGGER_PX = 50;

/** Decides the drawer action for a finger moved by (dx, dy) from startX. */
export function classifySwipe(
  startX: number,
  dx: number,
  dy: number,
  viewportWidth: number,
  drawers: DrawerState,
): SwipeAction | null {
  if (Math.abs(dx) < TRIGGER_PX || Math.abs(dx) < Math.abs(dy) * 1.5)
    return null;
  if (drawers.left) return dx < 0 ? "close-left" : null;
  if (drawers.right) return dx > 0 ? "close-right" : null;
  if (dx > 0 && startX <= EDGE_PX) return "open-left";
  if (dx < 0 && startX >= viewportWidth - EDGE_PX) return "open-right";
  return null;
}

export interface EdgeSwipeOptions {
  /** Offset of `doc`'s viewport within the dashboard viewport. */
  offsetX: () => number;
  viewportWidth: () => number;
  enabled: () => boolean;
  drawers: () => DrawerState;
  onSwipe: (action: SwipeAction) => void;
}

export function attachEdgeSwipe(
  doc: Document,
  options: EdgeSwipeOptions,
): void {
  let start: { x: number; y: number } | null = null;
  doc.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch && options.enabled()
          ? { x: touch.clientX + options.offsetX(), y: touch.clientY }
          : null;
    },
    { passive: true },
  );
  doc.addEventListener(
    "touchmove",
    (event) => {
      const touch = event.touches[0];
      if (start === null || event.touches.length !== 1 || !touch) {
        start = null;
        return;
      }
      const action = classifySwipe(
        start.x,
        touch.clientX + options.offsetX() - start.x,
        touch.clientY - start.y,
        options.viewportWidth(),
        options.drawers(),
      );
      if (action === null) return;
      start = null;
      options.onSwipe(action);
    },
    { passive: true },
  );
}
