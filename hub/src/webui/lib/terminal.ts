import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { button, el } from "./dom";
import type { CollabSession } from "./workspace";

interface TerminalEndpoint {
  url: string;
  ticket: string;
  directUrl?: string;
  directTicket?: string;
}

const TERMINAL_FEATURE = "terminal.v1";
const OUTPUT = 0x01;
const INPUT = 0x02;
const RESIZE = 0x03;
const ACK = 0x04;
const EXIT = 0x05;
const HELLO = 0x00;
const ACK_BATCH_BYTES = 32 * 1024;

function frame(type: number, body?: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + (body?.byteLength ?? 0));
  result[0] = type;
  if (body) result.set(body, 1);
  return result;
}

function connect(
  url: string,
  ticket: string,
  onData: (data: unknown) => void,
  timeoutMs: number,
): Promise<WebSocket> {
  let resolve!: (socket: WebSocket) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WebSocket>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let accepted = false;
  let settled = false;
  let failure: Error | null = null;
  const timeout = window.setTimeout(
    () => closeWithError(new Error("The terminal did not respond"), true),
    timeoutMs,
  );
  function closeWithError(error: Error, rejectImmediately = false): void {
    if (accepted || settled) return;
    failure ??= error;
    if (
      socket.readyState !== WebSocket.CLOSING &&
      socket.readyState !== WebSocket.CLOSED
    )
      socket.close();
    if (rejectImmediately) {
      window.clearTimeout(timeout);
      settled = true;
      reject(failure);
    }
  }
  socket.addEventListener("open", () => {
    if (failure) return;
    const ticketBytes = new TextEncoder().encode(ticket);
    const body = new Uint8Array(1 + ticketBytes.length);
    body[0] = 1;
    body.set(ticketBytes, 1);
    socket.send(frame(HELLO, body));
  });
  socket.addEventListener("message", (event) => {
    if (failure) return;
    if (accepted) {
      onData(event.data);
      return;
    }
    const data = event.data;
    const handle = (bytes: Uint8Array) => {
      if (failure) return;
      if (bytes[0] !== HELLO || bytes.length !== 3 || bytes[1] !== 1) {
        closeWithError(new Error("The terminal sent an invalid handshake"));
        return;
      }
      if (bytes[2] !== 0) {
        closeWithError(new Error("The terminal refused the connection"));
        return;
      }
      window.clearTimeout(timeout);
      accepted = true;
      settled = true;
      resolve(socket);
    };
    if (data instanceof ArrayBuffer) handle(new Uint8Array(data));
    else if (data instanceof Blob)
      void data.arrayBuffer().then((buffer) => handle(new Uint8Array(buffer)));
    else closeWithError(new Error("The terminal sent an invalid handshake"));
  });
  socket.addEventListener("error", () =>
    closeWithError(new Error("Could not connect to the terminal")),
  );
  socket.addEventListener("close", () => {
    if (settled) return;
    window.clearTimeout(timeout);
    settled = true;
    reject(failure ?? new Error("The terminal connection was refused"));
  });
  return promise;
}

export class TerminalWindow {
  readonly #dialog: HTMLDialogElement;
  readonly #title: HTMLElement;
  readonly #status: HTMLElement;
  readonly #error: HTMLElement;
  readonly #mount: HTMLElement;
  readonly #keys: HTMLElement;
  readonly #controlButton: HTMLButtonElement;
  readonly #reconnect: HTMLButtonElement;
  readonly #close: HTMLButtonElement;
  #session: CollabSession | null = null;
  #terminal: Terminal | null = null;
  #socket: WebSocket | null = null;
  #fit: FitAddon | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #ackBytes = 0;
  #attempt = 0;
  #exitReceived = false;
  #controlKey = false;

  constructor() {
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "terminal-dialog";
    this.#title = el("h2", { text: "Terminal" });
    this.#title.id = "terminal-dialog-title";
    this.#dialog.setAttribute("aria-labelledby", this.#title.id);
    this.#status = el("span", {
      className: "terminal-status",
      text: "Disconnected",
    });
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#error = el("p", { className: "terminal-error" });
    this.#error.setAttribute("role", "alert");
    this.#error.hidden = true;
    this.#mount = el("div", { className: "terminal-mount" });
    this.#keys = el("div", { className: "terminal-keys" });
    this.#reconnect = button("Reconnect", "small");
    this.#reconnect.hidden = true;
    this.#reconnect.addEventListener("click", () => void this.openSession());
    this.#close = button("Close", "small");
    this.#close.addEventListener("click", () => this.#dialog.close());
    const header = el("header", { className: "terminal-header" });
    const heading = el("div", { className: "terminal-heading" });
    heading.append(this.#title, this.#status);
    const actions = el("div", { className: "terminal-actions" });
    actions.append(this.#reconnect, this.#close);
    header.append(heading, actions);
    this.#keys.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("button"))
        event.preventDefault();
    });
    const keys: [string, string][] = [
      ["Esc", "\u001b"],
      ["Tab", "\t"],
      ["Ctrl", ""],
      ["↑", "\u001b[A"],
      ["↓", "\u001b[B"],
      ["←", "\u001b[D"],
      ["→", "\u001b[C"],
      ["|", "|"],
      ["~", "~"],
    ];
    this.#controlButton = button("Ctrl", "small");
    for (const [label, value] of keys) {
      const key =
        label === "Ctrl" ? this.#controlButton : button(label, "small");
      if (label === "Ctrl") {
        key.setAttribute("aria-label", "Control modifier");
        key.setAttribute("aria-pressed", "false");
        key.addEventListener("click", () => {
          this.#controlKey = !this.#controlKey;
          key.classList.toggle("active", this.#controlKey);
          key.setAttribute("aria-pressed", String(this.#controlKey));
          this.#terminal?.focus();
        });
      } else {
        key.setAttribute("aria-label", label);
        key.addEventListener("click", () => {
          this.#terminal?.input(value);
          this.#terminal?.focus();
        });
      }
      this.#keys.append(key);
    }
    this.#dialog.append(header, this.#error, this.#mount, this.#keys);
    this.#dialog.addEventListener("close", () => {
      this.#attempt += 1;
      this.#disconnect();
    });
    document.body.append(this.#dialog);
  }

  async open(session: CollabSession): Promise<void> {
    if (!session.features?.includes(TERMINAL_FEATURE)) return;
    this.#session = session;
    this.#title.textContent = `Terminal · ${session.sessionName || session.label || session.instanceId}`;
    this.#error.hidden = true;
    this.#reconnect.hidden = true;
    if (!this.#dialog.open) this.#dialog.showModal();
    await this.openSession();
  }

  async openSession(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const attempt = ++this.#attempt;
    this.#exitReceived = false;
    this.#controlKey = false;
    this.#controlButton.classList.remove("active");
    this.#controlButton.setAttribute("aria-pressed", "false");
    this.#disconnect();
    this.#error.hidden = true;
    this.#reconnect.hidden = true;
    this.#status.textContent = "Connecting…";
    try {
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-unicode11"),
        ]);
      if (attempt !== this.#attempt || !this.#dialog.open) return;
      this.#mount.replaceChildren();
      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
        fontSize: 14,
        scrollback: 5_000,
        theme: {
          background: "#101317",
          foreground: "#e8edf2",
          cursor: "#65b9e8",
          selectionBackground: "#2a5d79",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";
      terminal.open(this.#mount);
      this.#terminal = terminal;
      this.#fit = fit;
      this.#resizeObserver = new ResizeObserver(() => this.#fitTerminal());
      this.#resizeObserver.observe(this.#mount);
      terminal.onData((data) => {
        if (!this.#controlKey) {
          this.#sendInput(data);
          return;
        }
        this.#controlKey = false;
        this.#controlButton.classList.remove("active");
        this.#controlButton.setAttribute("aria-pressed", "false");
        const code = data.length === 1 ? data.toUpperCase().charCodeAt(0) : 0;
        this.#sendInput(
          code >= 0x40 && code <= 0x5f
            ? String.fromCharCode(code & 0x1f)
            : data,
        );
      });
      terminal.onResize(({ cols, rows }) => this.#sendResize(cols, rows));
      this.#fitTerminal();
      const response = await this.#requestEndpoint(session);
      if (attempt !== this.#attempt) return;
      let socket: WebSocket;
      const onData = (data: unknown) => void this.#onMessage(data);
      if (response.directUrl && response.directTicket) {
        try {
          socket = await connect(
            response.directUrl,
            response.directTicket,
            onData,
            1_500,
          );
        } catch {
          if (attempt !== this.#attempt) return;
          try {
            socket = await connect(
              response.url,
              response.ticket,
              onData,
              10_000,
            );
          } catch {
            if (attempt !== this.#attempt) return;
            const relay = await this.#requestEndpoint(session);
            if (attempt !== this.#attempt || !this.#dialog.open) return;
            socket = await connect(relay.url, relay.ticket, onData, 10_000);
          }
        }
      } else {
        socket = await connect(response.url, response.ticket, onData, 10_000);
      }
      if (attempt !== this.#attempt || !this.#dialog.open) {
        socket.close();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("The terminal closed during its handshake");
      this.#socket = socket;
      this.#ackBytes = 0;
      this.#status.textContent = "Connected";
      this.#reconnect.hidden = true;
      socket.addEventListener("close", () => this.#connectionEnded(attempt));
      socket.addEventListener("error", () => this.#connectionEnded(attempt));
      this.#fitTerminal();
      this.#sendResize(terminal.cols, terminal.rows);
      terminal.focus();
    } catch (error) {
      if (attempt !== this.#attempt) return;
      this.#showError(
        (error as Error).message || "Could not connect to the terminal",
      );
    }
  }

  async #requestEndpoint(session: CollabSession): Promise<TerminalEndpoint> {
    const agentId = `${session.host_id}:${session.instanceId}`;
    const response = await fetch(
      `/api/agents/${encodeURIComponent(agentId)}/terminal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `Terminal request failed (${response.status})`;
      throw new Error(message);
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("ticket" in body) ||
      typeof body.ticket !== "string" ||
      !("url" in body) ||
      typeof body.url !== "string" ||
      ("directUrl" in body &&
        body.directUrl !== undefined &&
        typeof body.directUrl !== "string") ||
      ("directTicket" in body &&
        body.directTicket !== undefined &&
        typeof body.directTicket !== "string")
    )
      throw new Error("The terminal request returned an invalid response");
    return body as TerminalEndpoint;
  }

  #fitTerminal(): void {
    if (!this.#dialog.open || !this.#fit) return;
    try {
      this.#fit.fit();
    } catch {
      // The fit addon can run before its container receives a measurable size.
    }
  }

  #sendInput(text: string): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      this.#socket.send(
        frame(INPUT, bytes.subarray(offset, offset + 16 * 1024)),
      );
    }
  }

  #sendResize(cols: number, rows: number): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    const body = new Uint8Array(4);
    const view = new DataView(body.buffer);
    view.setUint16(0, cols, false);
    view.setUint16(2, rows, false);
    this.#socket.send(frame(RESIZE, body));
  }

  async #onMessage(data: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data instanceof Blob)
      bytes = new Uint8Array(await data.arrayBuffer());
    else return;
    if (bytes.length < 1) return;
    if (bytes[0] === OUTPUT) {
      const output = bytes.subarray(1);
      if (!output.length) return;
      this.#terminal?.write(output, () => {
        this.#ackBytes += output.byteLength;
        if (this.#ackBytes < ACK_BATCH_BYTES) return;
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
        const body = new Uint8Array(4);
        new DataView(body.buffer).setUint32(0, this.#ackBytes, false);
        this.#socket.send(frame(ACK, body));
        this.#ackBytes = 0;
      });
    } else if (bytes[0] === EXIT) {
      this.#exitReceived = true;
      const code =
        bytes.length === 3
          ? new DataView(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength,
            ).getInt16(1, false)
          : 0;
      this.#showError(`The tmux terminal ended (exit ${code})`);
    }
  }

  #connectionEnded(attempt: number): void {
    if (attempt !== this.#attempt || !this.#dialog.open || this.#exitReceived)
      return;
    this.#showError("The terminal connection closed");
  }
  #showError(message: string): void {
    this.#status.textContent = "Disconnected";
    this.#error.textContent = message;
    this.#error.hidden = false;
    this.#reconnect.hidden = false;
  }

  #disconnect(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.#terminal?.dispose();
    this.#terminal = null;
    this.#fit = null;
  }
}
