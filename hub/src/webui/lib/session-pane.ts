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
  type SessionUsage,
  VIEW_ONLY_CONTROLS_NOTE,
  contextSummary,
  groupModels,
  modelValue,
  parseModelValue,
  postJson,
  requestJson,
  sessionApiBase,
  supportsSessionUsage,
  supportsSessionV1,
  usageApiUrl,
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
  readonly #modelSearch: HTMLInputElement;
  readonly #modelOptions: HTMLElement;
  #models: { provider: string; id: string; name: string }[] = [];
  #modelValue = "";
  #modelOpen = false;
  readonly #thinkingField: HTMLElement;
  readonly #thinkingSelect: HTMLSelectElement;
  readonly #compactInput: HTMLInputElement;
  readonly #compactButton: HTMLButtonElement;
  readonly #usageButton: HTMLButtonElement;
  readonly #usageDialog: HTMLDialogElement;
  readonly #usageTitle: HTMLElement;
  readonly #usageContent: HTMLElement;
  readonly #usageError: HTMLElement;
  #usageLoading = false;
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

    this.#modelSearch = document.createElement("input");
    this.#modelSearch.type = "text";
    this.#modelSearch.placeholder = "Search models";
    this.#modelSearch.setAttribute("aria-label", "Search models");
    this.#modelSearch.setAttribute("role", "combobox");
    this.#modelSearch.setAttribute("aria-autocomplete", "list");
    this.#modelSearch.setAttribute("aria-expanded", "false");
    this.#modelOptions = el("div", { className: "model-options" });
    this.#modelOptions.setAttribute("role", "listbox");
    this.#modelSearch.addEventListener("focus", () => {
      this.#modelSearch.value = "";
      this.#modelOpen = true;
      this.#renderModelOptions();
    });
    this.#modelSearch.addEventListener("input", () => {
      this.#modelOpen = true;
      this.#renderModelOptions();
    });
    this.#modelSearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.#modelOpen = false;
        this.#modelSearch.value =
          this.#models.find((model) => modelValue(model) === this.#modelValue)
            ?.name ?? "";
        this.#renderModelOptions();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.#modelOptions
          .querySelector<HTMLButtonElement>("button:not([hidden])")
          ?.click();
      }
    });
    this.#modelSearch.addEventListener("blur", () => {
      window.setTimeout(() => {
        this.#modelOpen = false;
        this.#modelSearch.value =
          this.#models.find((model) => modelValue(model) === this.#modelValue)
            ?.name ?? "";
        this.#renderModelOptions();
      }, 100);
    });
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
    this.#usageButton = button("Usage");
    this.#usageButton.type = "button";
    this.#usageButton.addEventListener("click", () => void this.#onUsage());
    compactRow.append(
      this.#compactInput,
      this.#compactButton,
      this.#usageButton,
    );
    compactForm.append(
      el("span", { className: "field-label", text: "Compact context" }),
      compactRow,
    );
    this.#usageDialog = document.createElement("dialog");
    this.#usageDialog.className = "usage-dialog";
    this.#usageTitle = el("h2", { text: "Provider usage" });
    this.#usageTitle.id = "usage-dialog-title";
    this.#usageDialog.setAttribute("aria-labelledby", this.#usageTitle.id);
    this.#usageError = el("p", { className: "pane-note error" });
    this.#usageError.setAttribute("role", "alert");
    this.#usageError.hidden = true;
    this.#usageContent = el("div", { className: "usage-content" });
    const usageClose = button("Close", "small");
    usageClose.type = "button";
    usageClose.addEventListener("click", () => this.#usageDialog.close());
    const usageHeader = el("header", { className: "usage-dialog-header" });
    usageHeader.append(this.#usageTitle, usageClose);
    this.#usageDialog.append(usageHeader, this.#usageError, this.#usageContent);
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
      field("Model", this.#modelSearch),
      this.#modelOptions,
      this.#thinkingField,
      compactForm,
      this.#abortButton,
    );
    this.element.append(
      el("h2", { text: "Session" }),
      this.#empty,
      this.#note,
      this.#usageDialog,
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
      this.#usageLoading = false;
      this.#usageDialog.close();
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

  #onModelChange(value: string): void {
    const target = parseModelValue(value);
    const current = this.#info?.model;
    if (!target || (current && modelValue(current) === value)) return;
    this.#modelValue = value;
    this.#pendingModel = value;
    void this.#act("Switching model", "/model", target);
  }

  #renderModelOptions(): void {
    const query = this.#modelSearch.value.trim().toLowerCase();
    const matches = this.#models.filter((model) =>
      `${model.name} ${model.provider} ${model.id}`
        .toLowerCase()
        .includes(query),
    );
    this.#modelOptions.hidden = !this.#modelOpen || !this.#canControl();
    this.#modelSearch.setAttribute(
      "aria-expanded",
      String(!this.#modelOptions.hidden),
    );
    this.#modelOptions.replaceChildren(
      ...matches.map((model) => {
        const option = button(
          `${model.name} (${model.provider})`,
          "model-option",
        );
        option.type = "button";
        option.setAttribute("role", "option");
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => {
          const value = modelValue(model);
          this.#modelValue = value;
          this.#modelSearch.value = model.name;
          this.#modelOpen = false;
          this.#renderModelOptions();
          this.#onModelChange(value);
        });
        return option;
      }),
    );
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
  async #onUsage(): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    if (
      !session ||
      !key ||
      this.#usageLoading ||
      !supportsSessionUsage(session) ||
      this.#info?.access !== "control"
    )
      return;
    this.#usageLoading = true;
    this.#usageError.hidden = true;
    this.#usageContent.textContent = "Loading provider usage…";
    this.#usageTitle.textContent = `Provider usage · ${sessionLabel(session)}`;
    this.#usageDialog.showModal();
    this.#update();
    try {
      const usage = await requestJson<SessionUsage>(
        usageApiUrl(session.host_id, session.instanceId),
      );
      if (this.#key !== key || this.#info?.access !== "control") return;
      this.#usageContent.replaceChildren(renderUsage(usage));
    } catch (error) {
      if (this.#key !== key || this.#info?.access !== "control") return;
      this.#usageError.textContent = (error as Error).message;
      this.#usageError.hidden = false;
      this.#usageContent.replaceChildren();
    } finally {
      if (this.#key === key) {
        this.#usageLoading = false;
        this.#update();
      }
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
      ["UUID", session.instanceId],
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
    this.#models = groups.flatMap((group) =>
      group.models
        .map((model) => ({ ...model }))
        .sort((a, b) =>
          b.name.localeCompare(a.name, undefined, { numeric: true }),
        ),
    );
    const currentModel =
      this.#pendingModel ?? (info?.model ? modelValue(info.model) : "");
    this.#modelValue = currentModel;
    if (!this.#modelOpen)
      this.#modelSearch.value =
        this.#models.find((model) => modelValue(model) === currentModel)
          ?.name ??
        info?.model?.name ??
        "";
    this.#renderModelOptions();

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
    this.#usageButton.hidden = !supportsSessionUsage(this.#session ?? {});
    const canReadUsage =
      !this.#usageButton.hidden && info?.access === "control";
    this.#usageButton.disabled = !canControl || this.#usageLoading;
    if (!canReadUsage && this.#usageDialog.open) this.#usageDialog.close();
  }
}
function renderUsage(usage: SessionUsage): HTMLElement {
  const providers = new Map<string, SessionUsage["reports"]>();
  for (const report of usage.reports) {
    const reports = providers.get(report.provider) ?? [];
    reports.push(report);
    providers.set(report.provider, reports);
  }
  const content = el("div", { className: "usage-providers" });
  if (providers.size === 0) {
    content.append(
      el("p", {
        className: "empty",
        text: "No provider quota reports are available.",
      }),
    );
    return content;
  }
  for (const [provider, reports] of [...providers].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const section = el("section", { className: "usage-provider" });
    section.append(el("h3", { text: provider }));
    reports.forEach((report, index) => {
      const account = el("div", { className: "usage-account" });
      const updated =
        report.fetchedAt === null
          ? ""
          : ` · updated ${elapsedText(Math.max(0, usage.generatedAt - report.fetchedAt))} ago`;
      account.append(el("h4", { text: `Account ${index + 1}${updated}` }));
      if (report.limits.length === 0) {
        account.append(
          el("p", { className: "empty", text: "No limits reported." }),
        );
      }
      for (const limit of report.limits) {
        const row = el("div", { className: "usage-limit" });
        row.append(
          el("span", { className: "usage-limit-label", text: limit.label }),
        );
        const summary = el("span", {
          className: "usage-limit-summary",
          text: usageAmountText(limit),
        });
        row.append(summary);
        if (limit.usedFraction !== null) {
          const percent = Math.max(0, Math.min(100, limit.usedFraction * 100));
          const meter = el("div", { className: "usage-meter" });
          meter.setAttribute("role", "progressbar");
          meter.setAttribute("aria-label", `${limit.label} used`);
          meter.setAttribute("aria-valuemin", "0");
          meter.setAttribute("aria-valuemax", "100");
          meter.setAttribute("aria-valuenow", String(Math.round(percent)));
          const fill = el("span");
          fill.style.width = `${percent}%`;
          meter.append(fill);
          row.append(meter);
        }
        if (
          limit.window?.resetsAt !== null &&
          limit.window?.resetsAt !== undefined
        ) {
          const reset = new Date(limit.window.resetsAt).toLocaleString();
          row.append(
            el("span", {
              className: "usage-reset",
              text: `${limit.window.resetLabel ?? "Resets"} ${reset}`,
            }),
          );
        }
        account.append(row);
      }
      section.append(account);
    });
    content.append(section);
  }
  return content;
}

function usageAmountText(
  limit: SessionUsage["reports"][number]["limits"][number],
): string {
  if (limit.unit === "percent" && limit.used !== null) {
    return `${formatUsageNumber(limit.used)}% used`;
  }
  if (limit.used !== null && limit.limit !== null) {
    return `${formatUsageNumber(limit.used)} / ${formatUsageNumber(limit.limit)} ${limit.unit}`;
  }
  if (limit.remaining !== null) {
    return `${formatUsageNumber(limit.remaining)} ${limit.unit} remaining`;
  }
  if (limit.usedFraction !== null)
    return `${Math.round(limit.usedFraction * 100)}% used`;
  return limit.status === "unknown"
    ? "Usage unavailable"
    : (limit.status ?? "Usage unavailable");
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
    value,
  );
}

function elapsedText(milliseconds: number): string {
  if (milliseconds < 60_000) return "less than a minute";
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000)
    return `${Math.floor(milliseconds / 3_600_000)}h`;
  return `${Math.floor(milliseconds / 86_400_000)}d`;
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
