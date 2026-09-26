// The inspector's Session tab: live info about the selected session plus its
// model, thinking, compact and abort controls.
//
// The pane owns one persistent element tree. The dashboard re-attaches
// `element` on every render instead of rebuilding it, and polling only
// rewrites the read-only info list and control attributes, so a half-typed
// compact instruction, focus, and an open <select> survive any re-render.

import { button, el } from "./dom";
import {
  ApiError,
  LatestResponseGate,
  MAX_COMPACT_INSTRUCTIONS,
  NEEDS_UPDATE_NOTE,
  type SessionInfo,
  VIEW_ONLY_CONTROLS_NOTE,
  contextSummary,
  groupModels,
  modelValue,
  parseModelValue,
  postJson,
  requestJson,
  sessionApiBase,
  supportsSessionV1,
} from "./session-api";
import { type CollabSession, sessionKey, sessionLabel } from "./workspace";

export const SESSION_REFRESH_MS = 5_000;

export interface PaneHost {
  showStatus(message: string, kind?: string): void;
}

export class SessionPane {
  readonly element: HTMLElement;
  readonly #host: PaneHost;
  readonly #gate = new LatestResponseGate();
  #session: CollabSession | null = null;
  #key: string | null = null;
  #info: SessionInfo | null = null;
  #loadError: string | null = null;
  #actionError: string | null = null;
  #unsupported = false;
  #busy: string | null = null;
  #active = false;
  #timer: number | undefined;
  /** Selector values requested by the in-flight action, shown until it ends. */
  #pendingModel: string | null = null;
  #pendingThinking: string | null = null;
  #refreshing = 0;
  #modelSignature = "";
  #thinkingSignature = "";

  readonly #empty: HTMLElement;
  readonly #note: HTMLElement;
  readonly #infoList: HTMLElement;
  readonly #controls: HTMLElement;
  readonly #hint: HTMLElement;
  readonly #modelSelect: HTMLSelectElement;
  readonly #thinkingField: HTMLElement;
  readonly #thinkingSelect: HTMLSelectElement;
  readonly #compactInput: HTMLInputElement;
  readonly #compactButton: HTMLButtonElement;
  readonly #abortButton: HTMLButtonElement;

  constructor(host: PaneHost) {
    this.#host = host;
    this.element = el("section", { className: "session-pane" });
    this.element.dataset.sessionPane = "";
    this.#empty = el("p", { className: "empty", text: "Select a session." });
    this.#note = el("p", { className: "pane-note" });
    this.#note.setAttribute("role", "status");
    this.#infoList = el("dl", { className: "info-grid" });

    this.#controls = el("div", { className: "session-controls" });
    this.#hint = el("p", { className: "controls-hint" });
    this.#hint.setAttribute("role", "status");

    this.#modelSelect = document.createElement("select");
    this.#modelSelect.addEventListener("change", () => this.#onModelChange());
    this.#thinkingSelect = document.createElement("select");
    this.#thinkingSelect.addEventListener("change", () =>
      this.#onThinkingChange(),
    );
    this.#thinkingField = field("Thinking", this.#thinkingSelect);

    const compactForm = el("form", { className: "compact-form" });
    this.#compactInput = document.createElement("input");
    this.#compactInput.type = "text";
    this.#compactInput.maxLength = MAX_COMPACT_INSTRUCTIONS;
    this.#compactInput.placeholder = "Optional instructions";
    this.#compactInput.setAttribute("aria-label", "Compact instructions");
    this.#compactButton = el("button", {
      type: "submit",
      text: "Compact",
    }) as HTMLButtonElement;
    const compactRow = el("div", { className: "compact-row" });
    compactRow.append(this.#compactInput, this.#compactButton);
    compactForm.append(
      el("span", { className: "field-label", text: "Compact context" }),
      compactRow,
    );
    compactForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#onCompact();
    });

    this.#abortButton = button("Abort", "danger");
    this.#abortButton.addEventListener("click", () => {
      void this.#act("Aborting", "/abort", {});
    });

    this.#controls.append(
      el("h3", { text: "Controls" }),
      this.#hint,
      field("Model", this.#modelSelect),
      this.#thinkingField,
      compactForm,
      this.#abortButton,
    );
    this.element.append(
      el("h2", { text: "Session" }),
      this.#empty,
      this.#note,
      this.#infoList,
      this.#controls,
    );
    this.#update();
  }

  /** The root the extension reported for `session`, once info has loaded. */
  cwdFor(session: CollabSession): string | undefined {
    return this.#key === sessionKey(session) ? this.#info?.cwd : undefined;
  }

  /**
   * Called on every dashboard render. A different session resets the pane;
   * the same session (a re-fetched object) only refreshes the polled fields.
   */
  setSession(session: CollabSession | null): void {
    const key = session ? sessionKey(session) : null;
    const wasSupported = this.#session
      ? supportsSessionV1(this.#session)
      : false;
    this.#session = session;
    if (key !== this.#key) {
      this.#key = key;
      this.#info = null;
      this.#loadError = null;
      this.#actionError = null;
      this.#pendingModel = null;
      this.#pendingThinking = null;
      this.#unsupported = false;
      this.#busy = null;
      this.#compactInput.value = "";
      this.#update();
      if (this.#active) void this.refresh();
      return;
    }
    this.#update();
    if (this.#active && !wasSupported && session && supportsSessionV1(session))
      void this.refresh();
  }

  /** Refreshes now and every SESSION_REFRESH_MS while the tab is showing. */
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    window.clearInterval(this.#timer);
    this.#timer = undefined;
    if (!active) return;
    void this.refresh();
    this.#timer = window.setInterval(() => {
      if (this.#refreshing === 0 && document.visibilityState === "visible")
        void this.refresh();
    }, SESSION_REFRESH_MS);
  }

  async refresh(): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key || !supportsSessionV1(session)) return;
    const ticket = this.#gate.begin(key);
    this.#refreshing += 1;
    try {
      const info = await requestJson<SessionInfo>(
        `${sessionApiBase(session.host_id, session.instanceId)}/info`,
      );
      if (!this.#gate.accept(ticket, this.#key)) return;
      this.#info = info;
      this.#loadError = null;
      this.#unsupported = false;
    } catch (error) {
      if (!this.#gate.accept(ticket, this.#key)) return;
      if (error instanceof ApiError && error.status === 501)
        this.#unsupported = true;
      else this.#loadError = (error as Error).message;
    } finally {
      this.#refreshing -= 1;
    }
    this.#update();
  }

  #canControl(): boolean {
    return (
      this.#info?.access === "control" && !this.#busy && !this.#unsupported
    );
  }

  async #act(label: string, path: string, body: unknown): Promise<boolean> {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key || this.#busy) return false;
    this.#busy = label;
    this.#actionError = null;
    // A read that started before this action describes the old state.
    this.#gate.invalidate();
    this.#update();
    let ok = false;
    try {
      await postJson(
        `${sessionApiBase(session.host_id, session.instanceId)}${path}`,
        body,
      );
      ok = true;
    } catch (error) {
      if (this.#key === key) {
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 501) this.#unsupported = true;
        else if (status === 403 && this.#info)
          this.#info = { ...this.#info, access: "view" };
        else this.#actionError = (error as Error).message;
      }
      this.#host.showStatus((error as Error).message, "warning");
    }
    if (this.#key !== key) return ok;
    this.#busy = null;
    if (!ok) {
      this.#pendingModel = null;
      this.#pendingThinking = null;
    }
    this.#update();
    await this.refresh();
    if (this.#key !== key) return ok;
    this.#pendingModel = null;
    this.#pendingThinking = null;
    this.#update();
    return ok;
  }

  #onModelChange(): void {
    const value = this.#modelSelect.value;
    const target = parseModelValue(value);
    const current = this.#info?.model;
    if (!target || (current && modelValue(current) === value)) return;
    this.#pendingModel = value;
    void this.#act("Switching model", "/model", target);
  }

  #onThinkingChange(): void {
    const level = this.#thinkingSelect.value;
    if (level === this.#info?.thinkingLevel) return;
    this.#pendingThinking = level;
    void this.#act("Setting thinking level", "/thinking", { level });
  }

  async #onCompact(): Promise<void> {
    if (!this.#canControl()) return;
    const key = this.#key;
    const instructions = this.#compactInput.value.trim();
    const ok = await this.#act(
      "Starting compaction",
      "/compact",
      instructions ? { instructions } : {},
    );
    if (ok && this.#key === key) {
      this.#compactInput.value = "";
      this.#host.showStatus("Compaction started", "ok");
    }
  }

  #update(): void {
    const session = this.#session;
    this.#empty.hidden = session !== null;
    this.#infoList.hidden = session === null;
    if (!session) {
      this.#note.hidden = true;
      this.#controls.hidden = true;
      return;
    }
    const supported = supportsSessionV1(session) && !this.#unsupported;
    const note = !supported ? NEEDS_UPDATE_NOTE : this.#loadError;
    this.#note.hidden = !note;
    this.#note.textContent = note ?? "";
    this.#note.classList.toggle("error", supported && !!this.#loadError);
    this.#renderInfo(session);
    this.#controls.hidden = !supported;
    if (supported) this.#renderControls();
  }

  #renderInfo(session: CollabSession): void {
    const info = this.#info;
    const rows: [string, string | HTMLElement][] = [
      ["Label", session.label ?? sessionLabel(session)],
      ["Host", session.host_id],
      ["Cwd", info?.cwd ?? session.cwd ?? "Unknown"],
    ];
    if (info) rows.push(["PID", String(info.pid)]);
    rows.push(
      ["Guests", String(session.participants ?? 0)],
      ["Access", info?.access ?? session.access],
    );
    if (info) {
      rows.push(
        ["State", info.idle ? "Idle" : "Working"],
        [
          "Model",
          info.model ? `${info.model.name} (${info.model.provider})` : "None",
        ],
        ["Thinking", info.thinkingLevel ?? "Off"],
        ["Context", contextMeter(info)],
      );
    }
    this.#infoList.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const dd = el("dd");
        dd.dataset.info = label.toLowerCase();
        dd.append(value);
        return [el("dt", { text: label }), dd];
      }),
    );
  }

  #renderControls(): void {
    const info = this.#info;
    const canControl = this.#canControl();
    let hint = "";
    if (!info) hint = this.#loadError ? "" : "Loading session…";
    else if (info.access !== "control") hint = VIEW_ONLY_CONTROLS_NOTE;
    else if (this.#busy) hint = `${this.#busy}…`;
    else if (this.#actionError) hint = this.#actionError;
    this.#hint.textContent = hint;
    this.#hint.hidden = hint === "";
    this.#hint.classList.toggle(
      "error",
      !!info && info.access === "control" && !this.#busy && !!this.#actionError,
    );

    const groups = groupModels(info?.models ?? [], info?.model ?? null);
    const modelSignature = JSON.stringify([groups, !info?.model]);
    if (modelSignature !== this.#modelSignature) {
      this.#modelSignature = modelSignature;
      const options: HTMLElement[] = [];
      if (!info?.model) {
        const none = new Option("No model", "", true, true);
        none.disabled = true;
        options.push(none);
      }
      for (const group of groups) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.provider;
        for (const model of group.models)
          optgroup.append(new Option(model.name, modelValue(model)));
        options.push(optgroup);
      }
      this.#modelSelect.replaceChildren(...options);
    }
    const currentModel =
      this.#pendingModel ?? (info?.model ? modelValue(info.model) : "");
    // Assigning an unchanged value is skipped so a poll cannot disturb a
    // selector the user has open.
    if (this.#modelSelect.value !== currentModel)
      this.#modelSelect.value = currentModel;
    this.#modelSelect.disabled = !canControl || groups.length === 0;

    const levels = info?.thinkingLevels ?? [];
    this.#thinkingField.hidden = levels.length === 0;
    const current = info?.thinkingLevel ?? "";
    const unlisted = current && !levels.includes(current) ? current : null;
    const thinkingSignature = JSON.stringify([levels, unlisted]);
    if (thinkingSignature !== this.#thinkingSignature) {
      this.#thinkingSignature = thinkingSignature;
      const options = levels.map((level) => new Option(level, level));
      if (unlisted) {
        const option = new Option(unlisted, unlisted);
        option.disabled = true;
        options.unshift(option);
      }
      this.#thinkingSelect.replaceChildren(...options);
    }
    const shownLevel = this.#pendingThinking ?? current;
    if (this.#thinkingSelect.value !== shownLevel)
      this.#thinkingSelect.value = shownLevel;
    this.#thinkingSelect.disabled = !canControl;

    const viewOnly = !!info && info.access !== "control";
    this.#compactInput.disabled = viewOnly;
    this.#compactButton.disabled = !canControl;
    this.#abortButton.disabled = !canControl || !info || info.idle;
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = el("label", { className: "field" });
  wrapper.append(
    el("span", { className: "field-label", text: label }),
    control,
  );
  return wrapper;
}

function contextMeter(info: SessionInfo): HTMLElement {
  const summary = contextSummary(info.contextUsage);
  const meter = el("div", { className: "context-meter" });
  if (summary.percent !== null) {
    const bar = el("div", { className: "context-bar" });
    bar.classList.toggle("warn", summary.percent >= 70);
    bar.classList.toggle("high", summary.percent >= 90);
    const fill = el("span");
    fill.style.width = `${summary.percent}%`;
    bar.append(fill);
    meter.append(bar);
  }
  meter.append(el("span", { text: summary.text }));
  return meter;
}
