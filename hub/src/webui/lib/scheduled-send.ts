// Scheduled send for the embedded Collab guest (control mode).
//
// Holding the guest's Send button for LONG_PRESS_MS opens a popover that
// queues the composer text to be sent later, either after a duration or at a
// clock time. The prompt is held by the session itself (the omp-connected
// extension's session.schedule_prompt), so it is sent even when this page is
// closed. A strip above the composer lists what is waiting, with a countdown
// and a cancel button, and is refreshed from the session so prompts queued
// from another device show up too.
//
// Like lib/collab-frame.ts this works on the same-origin guest document
// without patching it, and relies on these parts of the guest's markup:
// - `.sh-composer` (not `.sh-composer-ask`), holding the prompt textarea
//   `.sh-composer-input`, the Send button `.sh-composer-actions .sh-btn-primary`
//   and attached image chips `.sh-attachment`;
// - the `.sh-btn` / `.sh-btn-primary` button styles and the theme variables.

import { ApiError, postJson, requestJson } from "./session-api";

export const SCHEDULE_FEATURE = "session.schedule.v1";
export const LONG_PRESS_MS = 600;
/** The session's own limit; the popover refuses anything later. */
export const MAX_SCHEDULE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
/** A press that drifts further than this is a scroll or drag, not a hold. */
const HOLD_SLOP_PX = 10;
/** How often the strip re-reads the session's list while it is visible. */
const POLL_MS = 15_000;

const COMPOSER = ".sh-composer:not(.sh-composer-ask)";
const SEND_BUTTON = `${COMPOSER} .sh-composer-actions .sh-btn-primary`;
const PROMPT_INPUT = `${COMPOSER} .sh-composer-input`;
const ATTACHMENT = `${COMPOSER} .sh-attachment`;

const GUEST_CSS = `
${SEND_BUTTON} { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: none; }
${SEND_BUTTON}.omp-sched-holding {
  background-image: linear-gradient(to right, rgb(255 255 255 / 0.3) 50%, transparent 50%);
  background-size: 200% 100%;
  background-position: 100% 0;
  animation: omp-sched-hold ${LONG_PRESS_MS}ms linear forwards;
}
@keyframes omp-sched-hold { to { background-position: 0 0; } }
.omp-sched-pop {
  position: fixed; z-index: 60; box-sizing: border-box;
  width: min(300px, calc(100vw - 16px));
  display: grid; gap: 10px; padding: 12px;
  color: var(--fg); background: var(--bg-overlay, var(--bg-raised));
  border: 1px solid var(--border-strong, var(--border)); border-radius: var(--radius-lg, 8px);
  box-shadow: var(--shadow-overlay, 0 8px 24px rgb(0 0 0 / 0.35));
  font: 13px/1.4 var(--font-ui, system-ui, sans-serif);
}
.omp-sched-pop [hidden], .omp-sched-strip[hidden] { display: none !important; }
.omp-sched-title { font-weight: 600; }
.omp-sched-modes { display: flex; gap: 4px; }
.omp-sched-modes .sh-btn[aria-pressed="true"] { color: var(--fg); border-color: var(--accent); }
.omp-sched-fields { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); }
.omp-sched-fields input {
  box-sizing: border-box; width: 64px; padding: 4px 6px;
  color: var(--fg); background: var(--bg-inset, var(--bg));
  border: 1px solid var(--border); border-radius: var(--radius-sm, 4px);
  font: 16px var(--font-ui, system-ui, sans-serif); font-variant-numeric: tabular-nums;
}
.omp-sched-fields input[type="time"] { width: auto; }
.omp-sched-preview { color: var(--fg-muted); }
.omp-sched-note { color: var(--warn, var(--fg-muted)); }
.omp-sched-error { color: var(--err); }
.omp-sched-actions { display: flex; justify-content: flex-end; gap: 6px; }
.omp-sched-strip { position: fixed; z-index: 50; display: grid; gap: 4px; pointer-events: none; }
.omp-sched-item {
  pointer-events: auto; display: flex; align-items: center; gap: 8px;
  padding: 3px 4px 3px 10px; min-width: 0;
  color: var(--fg-muted); background: var(--bg-raised);
  border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius, 6px);
  box-shadow: var(--shadow-overlay, 0 4px 12px rgb(0 0 0 / 0.25));
  font: 12px/1.4 var(--font-ui, system-ui, sans-serif);
}
.omp-sched-when { color: var(--fg); white-space: nowrap; font-variant-numeric: tabular-nums; }
.omp-sched-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export interface ScheduledPrompt {
  id: string;
  text: string;
  /** Epoch ms by the session host's clock. */
  fireAt: number;
  createdAt: number;
}

export interface ScheduleApi {
  list(): Promise<ScheduledPrompt[]>;
  add(text: string, delayMs: number): Promise<ScheduledPrompt>;
  cancel(id: string): Promise<void>;
}

/** The hub routes for one session's scheduled prompts. */
export function scheduleApi(base: string): ScheduleApi {
  return {
    async list() {
      return (
        await requestJson<{ prompts: ScheduledPrompt[] }>(`${base}/scheduled`)
      ).prompts;
    },
    add(text, delayMs) {
      return postJson<ScheduledPrompt>(`${base}/scheduled`, { text, delayMs });
    },
    async cancel(id) {
      await requestJson(`${base}/scheduled/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  };
}

/**
 * Milliseconds from `now` to the next local wall-clock `HH:MM`: later today,
 * otherwise tomorrow. Null when `value` is not a valid time.
 */
export function delayUntilClock(value: string, now: Date): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime() - now.getTime();
}

/** Milliseconds for a whole-number hours + minutes duration (minutes may
 *  run past 59) of at least a minute and at most the session's limit; null
 *  otherwise. */
export function delayFromDuration(
  hours: number,
  minutes: number,
): number | null {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || minutes < 0) return null;
  const delay = (hours * 60 + minutes) * 60_000;
  return delay >= 60_000 && delay <= MAX_SCHEDULE_DELAY_MS ? delay : null;
}

/** "45s", "12m", "2h 05m", "3d 4h": the time left, rounded up. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24)
    return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Local "14:30", "tomorrow 07:00" or "Tue 09:15" for a time after `now`. */
export function formatFireTime(fireAt: number, now: Date): string {
  const at = new Date(fireAt);
  const clock = at.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dayStart = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${at.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}

/** A local `HH:MM` about an hour from `now`, on a five-minute boundary. */
function defaultClockValue(now: Date): string {
  const at = new Date(now.getTime() + 60 * 60_000);
  at.setMinutes(Math.ceil(at.getMinutes() / 5) * 5, 0, 0);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * Adds scheduled send to a freshly loaded guest document. Everything it
 * starts belongs to the guest window, so it all ends when the frame
 * navigates away.
 */
export function attachScheduledSend(doc: Document, api: ScheduleApi): void {
  const win = doc.defaultView;
  if (!win) return;
  const style = doc.createElement("style");
  style.textContent = GUEST_CSS;
  doc.head.append(style);

  let prompts: ScheduledPrompt[] = [];
  let hold: { timer: number; x: number; y: number; button: Element } | null =
    null;
  let swallowClick = false;
  let popover: HTMLElement | null = null;
  const strip = Object.assign(doc.createElement("div"), {
    className: "omp-sched-strip",
  });
  strip.setAttribute("aria-label", "Scheduled prompts");
  strip.hidden = true;
  doc.body.append(strip);

  const sendButton = (target: EventTarget | null): Element | null =>
    target instanceof win.Element ? target.closest(SEND_BUTTON) : null;
  const promptText = (): string =>
    doc.querySelector<HTMLTextAreaElement>(PROMPT_INPUT)?.value ?? "";

  function endHold(): void {
    if (!hold) return;
    win?.clearTimeout(hold.timer);
    hold.button.classList.remove("omp-sched-holding");
    hold = null;
  }

  doc.addEventListener(
    "pointerdown",
    (event) => {
      swallowClick = false;
      if (popover && !popover.contains(event.target as Node)) closePopover();
      const button = sendButton(event.target);
      if (
        !button ||
        (button as HTMLButtonElement).disabled ||
        event.button !== 0 ||
        promptText().trim() === ""
      )
        return;
      endHold();
      button.classList.add("omp-sched-holding");
      hold = {
        button,
        x: event.clientX,
        y: event.clientY,
        timer: win.setTimeout(() => {
          endHold();
          // The release still produces a click on Send; swallow that one.
          swallowClick = true;
          openPopover(button);
        }, LONG_PRESS_MS),
      };
    },
    true,
  );
  doc.addEventListener(
    "pointermove",
    (event) => {
      if (
        hold &&
        Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >
          HOLD_SLOP_PX
      )
        endHold();
    },
    true,
  );
  doc.addEventListener("pointerup", endHold, true);
  doc.addEventListener("pointercancel", endHold, true);
  doc.addEventListener(
    "click",
    (event) => {
      if (!swallowClick || !sendButton(event.target)) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  doc.addEventListener(
    "contextmenu",
    (event) => {
      if (sendButton(event.target)) event.preventDefault();
    },
    true,
  );

  function closePopover(): void {
    popover?.remove();
    popover = null;
  }

  function openPopover(anchor: Element): void {
    closePopover();
    const now = new Date();
    let mode: "in" | "at" = "in";

    const pop = Object.assign(doc.createElement("div"), {
      className: "omp-sched-pop",
    });
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Send later");
    const title = Object.assign(doc.createElement("div"), {
      className: "omp-sched-title",
      textContent: "Send later",
    });

    const modes = Object.assign(doc.createElement("div"), {
      className: "omp-sched-modes",
    });
    const inMode = Object.assign(doc.createElement("button"), {
      type: "button",
      className: "sh-btn",
      textContent: "In",
    });
    const atMode = Object.assign(doc.createElement("button"), {
      type: "button",
      className: "sh-btn",
      textContent: "At",
    });
    modes.append(inMode, atMode);

    const numberInput = (label: string, value: number) => {
      const input = Object.assign(doc.createElement("input"), {
        type: "number",
        min: "0",
        step: "1",
        inputMode: "numeric",
        value: String(value),
      });
      input.setAttribute("aria-label", label);
      return input;
    };
    const hoursInput = numberInput("hours", 0);
    const minutesInput = numberInput("minutes", 10);
    const inFields = Object.assign(doc.createElement("div"), {
      className: "omp-sched-fields",
    });
    inFields.append(
      hoursInput,
      doc.createTextNode("h"),
      minutesInput,
      doc.createTextNode("m"),
    );
    const clockInput = Object.assign(doc.createElement("input"), {
      type: "time",
      value: defaultClockValue(now),
    });
    clockInput.setAttribute("aria-label", "time");
    const atFields = Object.assign(doc.createElement("div"), {
      className: "omp-sched-fields",
    });
    atFields.append(clockInput);

    const preview = Object.assign(doc.createElement("div"), {
      className: "omp-sched-preview",
    });
    preview.setAttribute("aria-live", "polite");
    const note = Object.assign(doc.createElement("div"), {
      className: "omp-sched-note",
      textContent:
        "Images can't be scheduled. Remove them, or send this one now.",
    });
    const error = Object.assign(doc.createElement("div"), {
      className: "omp-sched-error",
    });
    error.setAttribute("role", "alert");

    const actions = Object.assign(doc.createElement("div"), {
      className: "omp-sched-actions",
    });
    const cancel = Object.assign(doc.createElement("button"), {
      type: "button",
      className: "sh-btn",
      textContent: "Cancel",
    });
    const confirm = Object.assign(doc.createElement("button"), {
      type: "button",
      className: "sh-btn sh-btn-primary",
      textContent: "Schedule",
    });
    actions.append(cancel, confirm);
    pop.append(title, modes, inFields, atFields, preview, note, error, actions);

    const delay = (): number | null =>
      mode === "in"
        ? delayFromDuration(
            Number(hoursInput.value || 0),
            Number(minutesInput.value || 0),
          )
        : delayUntilClock(clockInput.value, new Date());

    function update(): void {
      inMode.setAttribute("aria-pressed", String(mode === "in"));
      atMode.setAttribute("aria-pressed", String(mode === "at"));
      inFields.hidden = mode !== "in";
      atFields.hidden = mode !== "at";
      const hasImages = doc.querySelector(ATTACHMENT) !== null;
      note.hidden = !hasImages;
      const ms = delay();
      preview.textContent =
        ms === null
          ? mode === "in"
            ? "Pick a delay from 1 minute to 7 days."
            : "Pick a time."
          : `Sends ${formatFireTime(Date.now() + ms, new Date())} (in ${formatCountdown(ms)})`;
      confirm.disabled = ms === null || hasImages || promptText().trim() === "";
    }

    async function submit(): Promise<void> {
      const ms = delay();
      const text = promptText();
      if (ms === null || text.trim() === "" || confirm.disabled) return;
      confirm.disabled = true;
      error.textContent = "";
      try {
        const added = await api.add(text, ms);
        if (!win || doc.defaultView === null) return;
        clearPrompt(text);
        closePopover();
        prompts = [...prompts.filter((p) => p.id !== added.id), added].sort(
          (a, b) => a.fireAt - b.fireAt,
        );
        renderStrip();
      } catch (failure) {
        error.textContent = (failure as Error).message;
        update();
      }
    }

    inMode.addEventListener("click", () => {
      mode = "in";
      update();
      minutesInput.focus();
    });
    atMode.addEventListener("click", () => {
      mode = "at";
      update();
      clockInput.focus();
    });
    for (const input of [hoursInput, minutesInput, clockInput])
      input.addEventListener("input", update);
    cancel.addEventListener("click", closePopover);
    confirm.addEventListener("click", () => void submit());
    pop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
      } else if (
        event.key === "Enter" &&
        (event.target as Element).tagName === "INPUT"
      ) {
        event.preventDefault();
        void submit();
      }
    });

    update();
    doc.body.append(pop);
    popover = pop;
    placePopover(pop, anchor);
    minutesInput.focus();
    minutesInput.select();
  }

  function placePopover(pop: HTMLElement, anchor: Element): void {
    if (!win) return;
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.min(
      Math.max(8, rect.right - width),
      win.innerWidth - width - 8,
    );
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.bottom = `${Math.max(8, win.innerHeight - rect.top + 6)}px`;
  }

  /** Empties the composer if it still holds `sent`, through the value setter
   *  and an input event so the guest's own state follows. */
  function clearPrompt(sent: string): void {
    const input = doc.querySelector<HTMLTextAreaElement>(PROMPT_INPUT);
    if (!win || !input || input.value !== sent) return;
    Object.getOwnPropertyDescriptor(
      win.HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  function placeStrip(): void {
    if (!win) return;
    const composer = doc.querySelector<HTMLElement>(".sh-composer");
    const inner =
      composer?.querySelector<HTMLElement>(".sh-composer-inner") ?? composer;
    if (!composer || !inner) {
      strip.style.display = "none";
      return;
    }
    strip.style.display = "";
    const box = inner.getBoundingClientRect();
    strip.style.left = `${box.left}px`;
    strip.style.width = `${box.width}px`;
    strip.style.bottom = `${win.innerHeight - composer.getBoundingClientRect().top + 6}px`;
  }

  /** One row per waiting prompt, kept across renders so a tap on Cancel that
   *  spans a countdown tick still lands on the button it started on. */
  const rows = new Map<string, { item: HTMLElement; when: HTMLElement }>();

  function buildRow(prompt: ScheduledPrompt): {
    item: HTMLElement;
    when: HTMLElement;
  } {
    const item = Object.assign(doc.createElement("div"), {
      className: "omp-sched-item",
    });
    const when = Object.assign(doc.createElement("span"), {
      className: "omp-sched-when",
    });
    const text = Object.assign(doc.createElement("span"), {
      className: "omp-sched-text",
      textContent: prompt.text.replace(/\s+/g, " ").trim(),
      title: prompt.text,
    });
    const cancel = Object.assign(doc.createElement("button"), {
      type: "button",
      className: "sh-btn",
      textContent: "Cancel",
    });
    cancel.setAttribute("aria-label", "Cancel scheduled prompt");
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      api.cancel(prompt.id).then(
        () => {
          prompts = prompts.filter((p) => p.id !== prompt.id);
          renderStrip();
        },
        () => {
          cancel.disabled = false;
          void refresh();
        },
      );
    });
    item.append(when, text, cancel);
    return { item, when };
  }

  function renderStrip(): void {
    const now = Date.now();
    const waiting = new Set(prompts.map((prompt) => prompt.id));
    for (const [id, row] of rows) {
      if (waiting.has(id)) continue;
      row.item.remove();
      rows.delete(id);
    }
    const order = prompts.map((prompt) => {
      let row = rows.get(prompt.id);
      if (!row) {
        row = buildRow(prompt);
        rows.set(prompt.id, row);
      }
      const left = prompt.fireAt - now;
      row.when.textContent =
        left > 0
          ? `${formatFireTime(prompt.fireAt, new Date(now))} · in ${formatCountdown(left)}`
          : "sending…";
      return row.item;
    });
    if (order.some((item, index) => strip.children[index] !== item))
      strip.replaceChildren(...order);
    strip.hidden = prompts.length === 0;
    placeStrip();
  }

  async function refresh(): Promise<void> {
    try {
      const listed = await api.list();
      if (doc.defaultView === null) return;
      prompts = listed;
      renderStrip();
    } catch (error) {
      // A session no longer shared with control drops its waiting prompts
      // when they fall due, so stop showing them; any other failure keeps
      // the last list until the next poll.
      if (error instanceof ApiError && error.status === 403) {
        prompts = [];
        renderStrip();
      }
    }
  }

  let lastPoll = 0;
  win.setInterval(() => {
    if (doc.visibilityState !== "visible") return;
    const now = Date.now();
    // Poll on the interval, and again shortly after a prompt falls due so
    // it leaves the strip once the session has sent it.
    const overdue = prompts.some((p) => p.fireAt + 2_000 <= now);
    if (now - lastPoll >= POLL_MS || (overdue && now - lastPoll >= 3_000)) {
      lastPoll = now;
      void refresh();
    }
    if (prompts.length > 0) renderStrip();
  }, 1_000);
  // A phone's keyboard opening for the popover's inputs resizes the window;
  // keep both pinned above the composer rather than closing anything.
  win.addEventListener("resize", () => {
    placeStrip();
    const anchor = doc.querySelector(SEND_BUTTON);
    if (popover && anchor) placePopover(popover, anchor);
  });
  lastPoll = Date.now();
  void refresh();
}
