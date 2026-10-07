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
  #selected: PastSession | undefined;
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
    this.#new.onclick = () => {
      this.#selected = undefined;
      this.#name.value = "";
      this.#syncSelection();
    };
    actions.append(this.#submit, this.#new);
    this.#status.setAttribute("role", "status");
    form.append(actions, this.#status);
    form.onsubmit = (event) => {
      event.preventDefault();
      void this.#start();
    };
    this.#history.setAttribute("aria-label", "Past sessions, newest first");
    this.#dialog.append(
      header,
      form,
      el("h3", { text: "Resume a past session" }),
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

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(
      `/api/hosts/${encodeURIComponent(this.#host)}${path}`,
      init,
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(body.error || `Request failed (${response.status})`);
    return body as T;
  }

  async open(host: string, cwd = ""): Promise<void> {
    if (this.#submitting) return;
    const request = ++this.#request;
    this.#host = host;
    this.#title.textContent = `Start session on ${host}`;
    this.#path.value = cwd;
    this.#name.value = "";
    this.#selected = undefined;
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
      for (const session of result.sessions.sort(
        (a, b) => b.modifiedAt - a.modifiedAt,
      )) {
        const row = button("", "past-session");
        row.dataset.sessionId = session.sessionId;
        row.title = session.sessionId;
        row.setAttribute("aria-pressed", "false");
        row.append(
          el("strong", { text: session.title }),
          el("span", { text: session.cwd || "Working directory unknown" }),
          el("time", { text: new Date(session.modifiedAt).toLocaleString() }),
        );
        row.onclick = () => {
          this.#selected = session;
          this.#path.value = session.cwd;
          this.#name.value = session.name ?? "";
          this.#syncSelection();
        };
        this.#history.append(row);
      }
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

  #syncSelection(): void {
    this.#submit.textContent = this.#selected
      ? "Resume session"
      : "Start session";
    this.#new.disabled = !this.#selected;
    for (const row of this.#history.querySelectorAll<HTMLButtonElement>(
      ".past-session",
    )) {
      row.setAttribute(
        "aria-pressed",
        String(row.dataset.sessionId === this.#selected?.sessionId),
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
    this.#status.textContent = "Starting session…";
    try {
      const result = await this.#json<{ ok: true; label: string }>(
        "/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: this.#path.value,
            name: this.#name.value,
            ...(this.#selected ? { sessionId: this.#selected.sessionId } : {}),
          }),
        },
      );
      if (request !== this.#request) return;
      this.#dialog.close();
      this.onStarted(result.label);
    } catch (error) {
      if (request === this.#request)
        this.#status.textContent = (error as Error).message;
    } finally {
      this.#submitting = false;
      for (const control of controls) control.disabled = false;
      this.#syncSelection();
    }
  }
}
