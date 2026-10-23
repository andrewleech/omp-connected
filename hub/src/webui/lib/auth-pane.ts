// The inspector's Login tab: sign in to OAuth providers, enter API keys and
// log out stored credentials for the selected session.
//
// Like the other panes this is one persistent element tree. The provider list
// is rebuilt only when its content changes; the login flow panel updates its
// fields in place, so a half-typed code survives the 1 s status polling. A
// pasted code or API key lives only in the input element and in the request
// that submits it; the input is cleared on submit.

import { button, copyText, el } from "./dom";
import {
  ApiError,
  type AuthLoginStatus,
  type AuthProvider,
  LatestResponseGate,
  authApi,
  isLoginActive,
  isSafeLoginLink,
  sessionApiBase,
  supportsAuth,
} from "./session-api";
import type { PaneHost } from "./session-pane";
import { type CollabSession, sessionKey } from "./workspace";

export const LOGIN_POLL_MS = 1_000;
const MAX_INPUT_CHARS = 100_000;

const STATE_LABELS: Record<AuthLoginStatus["state"], string> = {
  starting: "Starting…",
  awaiting_auth: "Waiting for sign-in",
  awaiting_input: "Waiting for your input",
  done: "Logged in",
  failed: "Login failed",
  cancelled: "Login cancelled",
};

export class AuthPane {
  readonly element: HTMLElement;
  readonly #host: PaneHost;
  readonly #listGate = new LatestResponseGate();
  readonly #loginGate = new LatestResponseGate();
  readonly #empty: HTMLElement;
  readonly #note: HTMLElement;
  readonly #list: HTMLElement;
  readonly #flow: HTMLElement;
  readonly #flowTitle: HTMLElement;
  readonly #flowState: HTMLElement;
  readonly #linkRow: HTMLElement;
  readonly #openLink: HTMLAnchorElement;
  readonly #copyLink: HTMLButtonElement;
  readonly #authNote: HTMLElement;
  readonly #instructions: HTMLElement;
  readonly #progress: HTMLElement;
  readonly #promptForm: HTMLFormElement;
  readonly #promptMessage: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #submit: HTMLButtonElement;
  readonly #redirectNote: HTMLElement;
  readonly #result: HTMLElement;
  readonly #cancel: HTMLButtonElement;
  readonly #dismiss: HTMLButtonElement;
  /** The login id each visited session is running, so a return resumes it. */
  readonly #loginIds = new Map<string, string>();
  #session: CollabSession | null = null;
  #key: string | null = null;
  #providers: AuthProvider[] | null = null;
  #providerSignature = "";
  #loadError: string | null = null;
  #actionError: string | null = null;
  #pollError: string | null = null;
  #unsupported = false;
  #busy = false;
  #flowBusy = false;
  #active = false;
  #timer: number | undefined;
  #polling = false;
  #login: AuthLoginStatus | null = null;
  #settledLogin: string | null = null;
  #promptKey = "";
  #linkValue: string | null = null;
  #progressSignature = "";

  constructor(host: PaneHost) {
    this.#host = host;
    this.element = el("section", { className: "auth-pane" });
    this.element.dataset.authPane = "";
    this.#empty = el("p", { className: "empty", text: "Select a session." });
    this.#note = el("p", { className: "pane-note" });
    this.#note.setAttribute("role", "status");
    this.#list = el("div", { className: "auth-list" });

    this.#flow = el("section", { className: "auth-flow" });
    this.#flow.dataset.authFlow = "";
    this.#flow.hidden = true;
    this.#flowTitle = el("h3");
    this.#flowState = el("p", { className: "auth-state" });
    this.#flowState.dataset.authState = "";
    this.#flowState.setAttribute("role", "status");
    this.#openLink = document.createElement("a");
    this.#openLink.className = "button-link";
    this.#openLink.textContent = "Open login page";
    this.#openLink.target = "_blank";
    this.#openLink.rel = "noopener noreferrer";
    this.#copyLink = button("Copy link", "small");
    this.#copyLink.addEventListener("click", () => void this.#copy());
    this.#linkRow = el("div", { className: "auth-link-row" });
    this.#linkRow.append(this.#openLink, this.#copyLink);
    this.#authNote = el("p", {
      className: "auth-note",
      text: "Sign in on the opened page. If the browser ends on a page that cannot load (a localhost address), copy that page's full address and paste it here when asked.",
    });
    this.#instructions = el("p", { className: "auth-instructions" });
    this.#progress = el("ul", { className: "auth-progress" });

    this.#promptForm = document.createElement("form");
    this.#promptForm.className = "auth-prompt";
    this.#promptMessage = el("span", { className: "field-label" });
    this.#input = document.createElement("input");
    this.#input.autocomplete = "off";
    this.#input.spellcheck = false;
    this.#input.maxLength = MAX_INPUT_CHARS;
    this.#input.setAttribute("autocapitalize", "off");
    this.#input.setAttribute("aria-label", "Login input");
    this.#submit = el("button", {
      type: "submit",
      text: "Submit",
    }) as HTMLButtonElement;
    this.#redirectNote = el("p", {
      className: "auth-note",
      text: "After signing in, the browser may show a page that cannot load (a localhost address). Copy that page's full address from the address bar and paste it here.",
    });
    const inputRow = el("div", { className: "auth-input-row" });
    inputRow.append(this.#input, this.#submit);
    const promptField = el("label", { className: "field" });
    promptField.append(this.#promptMessage, inputRow);
    this.#promptForm.append(promptField, this.#redirectNote);
    this.#promptForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#submitInput();
    });

    this.#result = el("p", { className: "auth-result" });
    this.#result.setAttribute("role", "status");
    this.#cancel = button("Cancel login", "danger");
    this.#cancel.addEventListener("click", () => void this.#cancelLogin());
    this.#dismiss = button("Dismiss");
    this.#dismiss.addEventListener("click", () => this.#forgetLogin());
    const actions = el("div", { className: "auth-actions" });
    actions.append(this.#cancel, this.#dismiss);
    this.#flow.append(
      this.#flowTitle,
      this.#flowState,
      this.#linkRow,
      this.#authNote,
      this.#instructions,
      this.#progress,
      this.#promptForm,
      this.#result,
      actions,
    );

    this.element.append(
      el("h2", { text: "Login" }),
      this.#empty,
      this.#note,
      this.#flow,
      this.#list,
    );
    this.#update();
  }

  setSession(session: CollabSession | null): void {
    const key = session ? sessionKey(session) : null;
    const wasUsable = this.#usable();
    this.#session = session;
    if (key !== this.#key) {
      this.#key = key;
      this.#listGate.invalidate();
      this.#loginGate.invalidate();
      this.#stopPolling();
      this.#providers = null;
      this.#providerSignature = "";
      this.#loadError = null;
      this.#actionError = null;
      this.#pollError = null;
      this.#unsupported = false;
      this.#busy = false;
      this.#flowBusy = false;
      this.#login = null;
      this.#promptKey = "";
      this.#input.value = "";
      this.#list.replaceChildren();
      this.#update();
      if (this.#active) this.#begin();
      return;
    }
    this.#update();
    if (this.#active && !wasUsable && this.#usable()) this.#begin();
  }

  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    if (!active) {
      this.#stopPolling();
      return;
    }
    this.#begin();
  }

  /** Loads providers and resumes the session's remembered login, if any. */
  #begin(): void {
    if (!this.#usable()) return;
    void this.refresh();
    this.#resumePolling();
  }

  #usable(): boolean {
    const session = this.#session;
    return (
      !!session &&
      supportsAuth(session) &&
      session.access === "control" &&
      !this.#unsupported
    );
  }

  #api() {
    const session = this.#session;
    return session
      ? authApi(sessionApiBase(session.host_id, session.instanceId))
      : null;
  }

  async refresh(): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    if (!api || !key || !this.#usable()) return;
    const ticket = this.#listGate.begin(key);
    try {
      const result = await api.list();
      if (!this.#listGate.accept(ticket, this.#key)) return;
      this.#providers = result.providers;
      this.#loadError = null;
    } catch (error) {
      if (!this.#listGate.accept(ticket, this.#key)) return;
      this.#noteFailure(error, "load");
    }
    this.#update();
  }

  /** Records a request failure; 501 marks the session as lacking the feature. */
  #noteFailure(error: unknown, kind: "load" | "action"): void {
    if (error instanceof ApiError && error.status === 501)
      this.#unsupported = true;
    else if (kind === "load") this.#loadError = (error as Error).message;
    else this.#actionError = (error as Error).message;
  }

  async #startLogin(provider: AuthProvider): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    if (!api || !key || !this.#usable() || this.#busy || this.#loginActive())
      return;
    this.#busy = true;
    this.#actionError = null;
    this.#update();
    try {
      const status = await api.startLogin(provider.id);
      this.#loginIds.set(key, status.loginId);
      if (this.#key !== key) return;
      this.#loginGate.invalidate();
      this.#settledLogin = null;
      this.#pollError = null;
      this.#applyLogin(status);
      if (isLoginActive(status) && this.#active) this.#startPolling();
    } catch (error) {
      if (this.#key !== key) return;
      this.#noteFailure(error, "action");
      this.#host.showStatus((error as Error).message, "warning");
    } finally {
      if (this.#key === key) {
        this.#busy = false;
        this.#update();
      }
    }
  }

  #loginActive(): boolean {
    return !!this.#login && isLoginActive(this.#login);
  }

  #loginKey(): string | null {
    const loginId = this.#key ? this.#loginIds.get(this.#key) : undefined;
    return this.#key && loginId ? `${this.#key}/${loginId}` : null;
  }

  #resumePolling(): void {
    if (!this.#key || !this.#loginIds.has(this.#key)) return;
    void this.#pollLogin();
    // A login already settled stays visible without further requests.
    if (!this.#login || isLoginActive(this.#login)) this.#startPolling();
  }

  #startPolling(): void {
    window.clearInterval(this.#timer);
    this.#timer = window.setInterval(
      () => void this.#pollLogin(),
      LOGIN_POLL_MS,
    );
  }

  #stopPolling(): void {
    window.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #pollLogin(): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    const loginId = key ? this.#loginIds.get(key) : undefined;
    if (!api || !key || !loginId || !this.#active || this.#polling) return;
    this.#polling = true;
    const ticket = this.#loginGate.begin(`${key}/${loginId}`);
    try {
      const status = await api.loginStatus(loginId);
      if (!this.#loginGate.accept(ticket, this.#loginKey())) return;
      this.#pollError = null;
      this.#applyLogin(status);
    } catch (error) {
      if (!this.#loginGate.accept(ticket, this.#loginKey())) return;
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 404 || status === 403 || status === 501) {
        this.#forgetLogin();
        this.#noteFailure(error, "action");
      } else {
        this.#pollError = (error as Error).message;
      }
    } finally {
      this.#polling = false;
    }
    this.#update();
  }

  #applyLogin(status: AuthLoginStatus): void {
    this.#login = status;
    if (!isLoginActive(status)) {
      this.#stopPolling();
      if (this.#settledLogin !== status.loginId) {
        this.#settledLogin = status.loginId;
        void this.refresh();
      }
    }
    this.#update();
  }

  #forgetLogin(): void {
    this.#stopPolling();
    if (this.#key) this.#loginIds.delete(this.#key);
    this.#login = null;
    this.#pollError = null;
    this.#promptKey = "";
    this.#input.value = "";
    this.#loginGate.invalidate();
    this.#update();
  }

  async #submitInput(): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    const login = this.#login;
    if (
      !api ||
      !key ||
      !login ||
      login.state !== "awaiting_input" ||
      this.#flowBusy
    )
      return;
    const value = this.#input.value;
    if (value.trim() === "") return;
    this.#input.value = "";
    this.#flowBusy = true;
    this.#pollError = null;
    this.#update();
    try {
      await api.submitInput(login.loginId, value);
    } catch (error) {
      if (this.#key === key && this.#input.value === "")
        this.#input.value = value;
      if (this.#key === key) this.#pollError = (error as Error).message;
    } finally {
      if (this.#key === key) {
        this.#flowBusy = false;
        this.#update();
        void this.#pollLogin();
      }
    }
  }

  async #cancelLogin(): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    const login = this.#login;
    if (!api || !key || !login || this.#flowBusy) return;
    this.#flowBusy = true;
    this.#update();
    try {
      await api.cancelLogin(login.loginId);
    } catch (error) {
      if (this.#key === key) this.#pollError = (error as Error).message;
    } finally {
      if (this.#key === key) {
        this.#flowBusy = false;
        this.#update();
        void this.#pollLogin();
      }
    }
  }

  async #logout(provider: AuthProvider, credentialId: number): Promise<void> {
    const api = this.#api();
    const key = this.#key;
    const account = provider.accounts.find(
      (candidate) => candidate.credentialId === credentialId,
    );
    if (!api || !key || !account || this.#busy) return;
    if (
      !window.confirm(
        `Log out ${account.label} from ${provider.name}? Its stored credential is removed from the host running this session.`,
      )
    )
      return;
    this.#busy = true;
    this.#actionError = null;
    this.#update();
    try {
      const result = await api.logout(provider.id, credentialId);
      if (this.#key !== key) return;
      this.#host.showStatus(
        result.remainingSource
          ? `Logged out; ${provider.name} still has credentials from ${result.remainingSource}`
          : `Logged out of ${provider.name}`,
        "ok",
      );
    } catch (error) {
      if (this.#key !== key) return;
      this.#noteFailure(error, "action");
      this.#host.showStatus((error as Error).message, "warning");
    } finally {
      if (this.#key === key) {
        this.#busy = false;
        this.#update();
        void this.refresh();
      }
    }
  }

  async #copy(): Promise<void> {
    if (!this.#linkValue) return;
    const copied = await copyText(this.#linkValue);
    this.#host.showStatus(
      copied ? "Login link copied" : "Could not copy the login link",
      copied ? "ok" : "warning",
    );
  }

  #renderProviders(): void {
    const providers = this.#providers ?? [];
    const writable = this.#usable() && !this.#busy && !this.#loginActive();
    const signature = JSON.stringify([providers, writable, this.#busy]);
    if (signature === this.#providerSignature) return;
    this.#providerSignature = signature;
    this.#list.replaceChildren(
      ...providers.map((provider) => this.#providerRow(provider, writable)),
    );
  }

  #providerRow(provider: AuthProvider, writable: boolean): HTMLElement {
    const row = el("div", { className: "auth-provider" });
    row.dataset.providerId = provider.id;
    const head = el("div", { className: "auth-provider-head" });
    head.append(el("strong", { text: provider.name }));
    head.append(
      el("span", {
        className: `auth-badge${provider.authenticated ? " ok" : ""}`,
        text: provider.authenticated ? "authenticated" : "not authenticated",
      }),
    );
    const login = button(provider.authenticated ? "Re-login" : "Login", "small");
    login.dataset.authLogin = provider.id;
    login.disabled = !writable || !provider.available;
    if (!provider.available) login.title = "Not available on this host";
    login.addEventListener("click", () => void this.#startLogin(provider));
    head.append(login);
    row.append(head);
    for (const account of provider.accounts) {
      const line = el("div", { className: "auth-account" });
      const text = el("div", { className: "auth-account-text" });
      text.append(
        el("span", {
          className: "auth-account-label",
          text: account.label,
        }),
        el("span", {
          className: "auth-account-detail",
          text: [
            account.type === "oauth" ? "OAuth" : "API key",
            account.detail,
            account.active ? "active" : "",
          ]
            .filter(Boolean)
            .join(" · "),
        }),
      );
      const logout = button("Log out", "small danger");
      logout.dataset.authLogout = String(account.credentialId);
      logout.disabled = !writable;
      logout.addEventListener(
        "click",
        () => void this.#logout(provider, account.credentialId),
      );
      line.append(text, logout);
      row.append(line);
    }
    return row;
  }

  #renderFlow(): void {
    const login = this.#login;
    this.#flow.hidden = !login;
    if (!login) {
      this.#linkValue = null;
      return;
    }
    const providerName =
      this.#providers?.find((provider) => provider.id === login.providerId)
        ?.name ?? login.providerId;
    setText(this.#flowTitle, `Login: ${providerName}`);
    setText(this.#flowState, STATE_LABELS[login.state]);
    this.#flowState.dataset.authState = login.state;

    // `launchUrl` is a launcher on the omp host's own machine; only `url`
    // works from the browser the user is on.
    const link = login.url ?? login.launchUrl ?? null;
    this.#linkValue = link;
    this.#linkRow.hidden = !link;
    const safe = !!link && isSafeLoginLink(link);
    this.#openLink.hidden = !safe;
    if (safe && this.#openLink.href !== link) this.#openLink.href = link;
    if (!safe) this.#openLink.removeAttribute("href");
    this.#authNote.hidden = !(link && login.state === "awaiting_auth");

    setText(this.#instructions, login.instructions ?? "");
    this.#instructions.hidden = !login.instructions;

    const progressSignature = JSON.stringify(login.progress);
    if (progressSignature !== this.#progressSignature) {
      this.#progressSignature = progressSignature;
      this.#progress.replaceChildren(
        ...login.progress.map((line) => el("li", { text: line })),
      );
    }
    this.#progress.hidden = login.progress.length === 0;

    const prompt = login.state === "awaiting_input" ? login.prompt : undefined;
    this.#promptForm.hidden = !prompt;
    if (prompt) {
      const promptKey = JSON.stringify([
        login.loginId,
        prompt.message,
        prompt.secret,
      ]);
      if (promptKey !== this.#promptKey) {
        this.#promptKey = promptKey;
        this.#input.value = "";
      }
      setText(this.#promptMessage, prompt.message);
      this.#input.type = prompt.secret ? "password" : "text";
      this.#input.placeholder = prompt.placeholder ?? "";
      this.#redirectNote.hidden = prompt.secret;
      this.#input.disabled = this.#flowBusy;
      this.#submit.disabled = this.#flowBusy;
    } else {
      this.#promptKey = "";
      this.#input.value = "";
    }

    const parts: string[] = [];
    if (login.state === "done")
      parts.push(
        login.identity ? `Logged in as ${login.identity}` : "Logged in",
      );
    if (login.state === "failed" && login.error) parts.push(login.error);
    if (this.#pollError) parts.push(this.#pollError);
    setText(this.#result, parts.join(". "));
    this.#result.hidden = parts.length === 0;
    this.#result.classList.toggle(
      "error",
      login.state === "failed" || !!this.#pollError,
    );

    const active = isLoginActive(login);
    this.#cancel.hidden = !active;
    this.#cancel.disabled = this.#flowBusy;
    this.#dismiss.hidden = active;
  }

  #update(): void {
    const session = this.#session;
    this.#empty.hidden = session !== null;
    if (!session) {
      this.#note.hidden = true;
      this.#list.hidden = true;
      this.#flow.hidden = true;
      return;
    }
    const note = !supportsAuth(session) || this.#unsupported
      ? "Login requires a newer omp-connected extension."
      : session.access !== "control"
        ? "Login needs a control-shared session."
        : (this.#loadError ??
          this.#actionError ??
          (this.#providers ? null : "Loading providers…"));
    this.#note.hidden = !note;
    this.#note.textContent = note ?? "";
    this.#note.classList.toggle(
      "error",
      !!note && !!(this.#loadError ?? this.#actionError),
    );
    const usable = this.#usable();
    this.#list.hidden = !usable || !this.#providers;
    if (!usable) {
      this.#flow.hidden = true;
      return;
    }
    this.#renderProviders();
    this.#renderFlow();
  }
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
