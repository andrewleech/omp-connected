import { button, el } from "./dom";

interface PastSession {
  sessionId: string;
  cwd: string;
  title: string;
  modifiedAt: number;
  name?: string;
}

/** A standalone dialog keeps an in-progress form intact during fleet polling. */
export class SessionLauncher {
  readonly #dialog = el("dialog", {
    className: "session-launcher",
  }) as HTMLDialogElement;
  readonly #title = el("h2");
  readonly #path = document.createElement("input");
  readonly #name = document.createElement("input");
  readonly #history = el("div", { className: "session-history" });
  readonly #status = el("p", { className: "session-launch-status" });
  readonly #submit = button("Start session");
  readonly #new = button("New session", "small");
  readonly #selected = new Set<string>();
  readonly #reservedLabels: string[] = [];
  readonly #batchRetries = new Set<string>();
  #anchor: string | undefined;
  #range: string[] = [];
  #sessions: PastSession[] = [];
  readonly #filter = document.createElement("input");
  #host = "";
  #request = 0;
  #submitting = false;

  constructor(private readonly onStarted: (label: string) => void) {
    this.#dialog.dataset.sessionLauncher = "";
    this.#title.id = "session-launch-title";
    this.#dialog.setAttribute("aria-labelledby", this.#title.id);
    const header = el("header", { className: "session-launch-header" });
    const close = button("Close", "small");
    close.onclick = () => this.#dialog.close();
    header.append(this.#title, close);
    const form = document.createElement("form");
    form.className = "session-launch-form";
    this.#path.required = true;
    this.#path.placeholder = "/path/to/project or ~/project";
    this.#name.placeholder = "Optional suffix";
    this.#name.maxLength = 64;
    this.#name.pattern = "[A-Za-z0-9_.][A-Za-z0-9_.-]*";
    for (const [text, input] of [
      ["Path", this.#path],
      ["Name", this.#name],
    ] as const) {
      const label = el("label", { text });
      label.append(input);
      form.append(label);
    }
    form.append(
      el("p", {
        className: "empty",
        text: "Name is the ompc suffix: /work/project + review starts project.review. Leave it blank for project.",
      }),
    );
    const actions = el("div", { className: "session-launch-actions" });
    this.#submit.type = "submit";
    this.#new.onclick = () => this.#clearSelection();
    actions.append(this.#submit, this.#new);
    this.#status.setAttribute("role", "status");
    form.append(actions, this.#status);
    form.onsubmit = (event) => {
      event.preventDefault();
      void this.#start();
    };
    this.#filter.type = "search";
    this.#filter.placeholder = "Filter past sessions";
    this.#filter.className = "session-history-filter";
    this.#filter.setAttribute("aria-label", "Filter past sessions");
    this.#filter.oninput = () => this.#render();
    this.#history.setAttribute("aria-label", "Past sessions, newest first");
    this.#dialog.append(
      header,
      form,
      el("h3", { text: "Resume past sessions" }),
      el("p", {
        className: "empty",
        text: "Ctrl-click (Cmd-click on Mac) to toggle sessions, or Shift-click to select a range.",
      }),
      this.#filter,
      this.#history,
    );
    this.#dialog.addEventListener("click", (event) => {
      if (event.target === this.#dialog && !this.#submitting)
        this.#dialog.close();
    });
    this.#dialog.addEventListener("cancel", (event) => {
      if (this.#submitting) event.preventDefault();
    });
    this.#dialog.addEventListener("close", () => {
      this.#request++;
    });
    document.body.append(this.#dialog);
  }

  async #json<T>(
    path: string,
    init?: RequestInit,
    retryRateLimit = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(
        `/api/hosts/${encodeURIComponent(this.#host)}${path}`,
        init,
      );
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body as T;
      if (retryRateLimit && response.status === 429 && attempt < 8) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = Number(retryAfter);
        const delay =
          retryAfter && Number.isFinite(seconds)
            ? seconds * 1000
            : retryAfter
              ? Date.parse(retryAfter) - Date.now()
              : 0;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(
          resolve,
          Math.max(
            Number.isFinite(delay) ? delay : 0,
            Math.min(1000 * 2 ** attempt, 10_000),
          ),
        );
        await promise;
        continue;
      }
      throw new Error(body.error || `Request failed (${response.status})`);
    }
  }

  async open(host: string, cwd = ""): Promise<void> {
    if (this.#submitting) return;
    const request = ++this.#request;
    this.#host = host;
    this.#title.textContent = `Start session on ${host}`;
    this.#path.value = cwd;
    this.#name.value = "";
    this.#selected.clear();
    this.#reservedLabels.length = 0;
    this.#batchRetries.clear();
    this.#anchor = undefined;
    this.#range = [];
    this.#sessions = [];
    this.#filter.value = "";
    this.#history.replaceChildren();
    this.#status.textContent = "Loading past sessions…";
    this.#syncSelection();
    if (!this.#dialog.open) this.#dialog.showModal();
    try {
      const result = await this.#json<{ sessions: PastSession[] }>(
        "/session-history",
      );
      if (request !== this.#request) return;
      this.#status.textContent = "";
      this.#sessions = result.sessions;
      this.#filter.value = "";
      this.#render();
      if (result.sessions.length === 0)
        this.#history.append(
          el("p", {
            className: "empty",
            text: "No past sessions available. Conversations already open on this host are excluded.",
          }),
        );
    } catch (error) {
      if (request !== this.#request) return;
      this.#status.textContent = (error as Error).message;
    }
  }

  #render(): void {
    const needle = this.#filter.value.trim().toLowerCase();
    const visible = [...this.#sessions]
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .filter((session) =>
        `${session.title}\n${session.cwd}`.toLowerCase().includes(needle),
      );
    this.#history.replaceChildren();
    for (const session of visible) {
      const row = button("", "past-session");
      row.dataset.sessionId = session.sessionId;
      row.title = session.sessionId;
      row.setAttribute("aria-pressed", "false");
      row.append(
        el("strong", {
          text: session.title,
          title: session.title,
        }),
        el("span", {
          text: session.cwd || "Working directory unknown",
          title: session.cwd || "Working directory unknown",
        }),
        el("time", { text: new Date(session.modifiedAt).toLocaleString() }),
      );
      row.onmousedown = (event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey)
          event.preventDefault();
      };
      row.onclick = (event) => {
        const anchor = visible.findIndex(
          (item) => item.sessionId === this.#anchor,
        );
        const clicked = visible.indexOf(session);
        if (event.shiftKey && anchor !== -1) {
          for (const id of this.#range) this.#selected.delete(id);
          this.#range = visible
            .slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1)
            .map((item) => item.sessionId);
          for (const id of this.#range) this.#selected.add(id);
        } else if (event.ctrlKey || event.metaKey) {
          if (this.#selected.has(session.sessionId))
            this.#selected.delete(session.sessionId);
          else this.#selected.add(session.sessionId);
          this.#anchor = session.sessionId;
          this.#range = [];
        } else {
          this.#selected.clear();
          this.#selected.add(session.sessionId);
          this.#anchor = session.sessionId;
          this.#range = [session.sessionId];
        }
        if (this.#selected.size === 0) {
          this.#clearSelection();
          return;
        }
        if (this.#selected.size === 1) {
          const selected = this.#sessions.find((item) =>
            this.#selected.has(item.sessionId),
          );
          if (selected) {
            this.#path.value = selected.cwd;
            this.#name.value = selected.name ?? "";
          }
        }
        this.#status.textContent = "";
        this.#syncSelection();
      };
      this.#history.append(row);
    }
    this.#syncSelection();
  }

  #clearSelection(): void {
    this.#selected.clear();
    this.#reservedLabels.length = 0;
    this.#batchRetries.clear();
    this.#anchor = undefined;
    this.#range = [];
    this.#status.textContent = "";
    this.#name.value = "";
    this.#syncSelection();
  }

  #syncSelection(): void {
    const count = this.#selected.size;
    this.#submit.textContent =
      count > 1
        ? `Resume ${count} sessions`
        : count
          ? "Resume session"
          : "Start session";
    this.#new.disabled = this.#submitting || count === 0;
    this.#path.disabled = this.#submitting || count > 1;
    this.#name.disabled = this.#submitting || count > 1;
    for (const row of this.#history.querySelectorAll<HTMLButtonElement>(
      ".past-session",
    )) {
      row.setAttribute(
        "aria-pressed",
        String(this.#selected.has(row.dataset.sessionId ?? "")),
      );
    }
  }

  async #start(): Promise<void> {
    if (this.#submitting) return;
    this.#submitting = true;
    const request = this.#request;
    const controls = this.#dialog.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input, button");
    for (const control of controls) control.disabled = true;
    const selected = [
      ...new Map(
        this.#sessions
          .filter((session) => this.#selected.has(session.sessionId))
          .map((session) => [session.sessionId, session]),
      ).values(),
    ];
    const batch = selected.length > 1;
    const launches = selected.length ? selected : [undefined];
    const failures: string[] = [];
    const reservedLabels = this.#reservedLabels;
    this.#status.textContent = batch
      ? "Resuming sessions…"
      : "Starting session…";
    try {
      for (const session of launches) {
        const batchRetry = session && this.#batchRetries.has(session.sessionId);
        const useSessionData = session && batch;
        try {
          const result = await this.#json<{ ok: true; label: string }>(
            "/sessions",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                cwd: useSessionData ? session.cwd : this.#path.value,
                name: useSessionData ? (session.name ?? "") : this.#name.value,
                ...(session ? { sessionId: session.sessionId } : {}),
                ...(batch || batchRetry || reservedLabels.length
                  ? { reservedLabels }
                  : {}),
              }),
            },
            true,
          );
          if (request !== this.#request) return;
          if (batch || batchRetry || reservedLabels.length)
            reservedLabels.push(result.label);
          if (session) {
            this.#selected.delete(session.sessionId);
            this.#batchRetries.delete(session.sessionId);
            this.#sessions = this.#sessions.filter(
              (item) => item.sessionId !== session.sessionId,
            );
          }
          this.onStarted(result.label);
        } catch (error) {
          if (request !== this.#request) return;
          if (batch && session) this.#batchRetries.add(session.sessionId);
          const message = (error as Error).message;
          failures.push(
            session
              ? `${session.title} (${session.sessionId}): ${message}`
              : message,
          );
        }
      }
      this.#range = [];
      if (failures.length === 0) {
        this.#dialog.close();
      } else {
        if (batch && this.#selected.size === 1) {
          const remaining = this.#sessions.find((session) =>
            this.#selected.has(session.sessionId),
          );
          if (remaining) {
            this.#path.value = remaining.cwd;
            this.#name.value = remaining.name ?? "";
          }
        }
        this.#status.textContent = failures.join("\n");
      }
    } finally {
      this.#submitting = false;
      for (const control of controls) control.disabled = false;
      this.#render();
    }
  }
}
