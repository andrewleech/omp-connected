// Lightweight Collab tail viewer — connects to a Collab room, decrypts
// frames, and renders only the most recent session entries.  Older entries
// are buffered and lazy-loaded on scroll-up.
//
// This replaces the full collab-web iframe for the dashboard's "view"
// mode to avoid replaying the entire session history (which kills the
// browser tab for long sessions).

const IV_LENGTH = 12;
const ENVELOPE_HEADER = 4;
const ROOM_KEY_BYTES = 32;
const COLLAB_PROTO = 3;

/** How many entries to show initially; more are prepended on scroll-up. */
const INITIAL_TAIL = 80;
/** How many earlier entries to prepend per scroll-up page. */
const PAGE_SIZE = 40;

// ─── Crypto ──────────────────────────────────────────────────────────────

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(
  key: CryptoKey,
  frame: Record<string, unknown>,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(frame));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_LENGTH);
  return out;
}

async function unseal(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Record<string, unknown>> {
  const iv = data.subarray(0, IV_LENGTH);
  const ct = data.subarray(IV_LENGTH);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER);
  return out;
}

// ─── Link parsing ────────────────────────────────────────────────────────

interface ParsedLink {
  wsUrl: string;
  key: Uint8Array;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function parseCollabLink(link: string): ParsedLink | null {
  // The dashboard link is `https://origin/collab/#<relay-link>` where
  // relay-link is `wss://relay/r/<roomId>.<b64url-key>`.
  let text = link.trim().replace(/%23/gi, "#");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // HTTP(S) deep link: the fragment carries the real collab link.
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hash.length > 1
  ) {
    return parseCollabLink(url.hash.slice(1));
  }
  // ws/wss direct link or scheme-less
  if (!text.includes("://")) text = `wss://${text}`;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const m = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/.exec(
    url.pathname,
  );
  if (!m) return null;
  const fragment =
    m[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!fragment || !B64URL.test(fragment)) return null;

  const raw = Uint8Array.from(atob(fragment.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (raw.byteLength < ROOM_KEY_BYTES) return null;
  const key = raw.subarray(0, ROOM_KEY_BYTES);
  const origin = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  const wsUrl = `${origin}//${url.host}/r/${m[1]}`;
  return { wsUrl, key };
}

// ─── Entry rendering ─────────────────────────────────────────────────────

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  /** toolCall uses `arguments`, tool_use (Anthropic raw) uses `input`. */
  arguments?: Record<string, unknown>;
  input?: unknown;
  id?: string;
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    /** toolResult message fields */
    toolName?: string;
    isError?: boolean;
  };
  summary?: string;
  tokensBefore?: number;
  model?: string;
  [key: string]: unknown;
}

const PREVIEW_LINES = 8;
const CONTENT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, create: true };

function truncLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(0, n).join("\n") + `\n… ${lines.length - n} more lines`;
}

/** Get the args object from a toolCall/tool_use block (handles both wire formats). */
function blockArgs(block: ContentBlock): unknown {
  return block.arguments ?? block.input;
}

/** Check if a content block is a tool call (handles both wire format names). */
function isToolCall(block: ContentBlock): boolean {
  return block.type === "toolCall" || block.type === "tool_use";
}

// ── Assistant message ───────────────────────────────────────────────────

function renderAssistantEntry(entry: SessionEntry): HTMLElement {
  const content = entry.message!.content;
  const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
  const hasText = blocks.some((b) => b.type === "text" && b.text?.trim());
  const hasThinking = blocks.some((b) => b.type === "thinking" && b.thinking?.trim());
  const toolCalls = blocks.filter(isToolCall);

  // Pure tool-call message (no text) → render as tool card(s)
  if (!hasText && !hasThinking && toolCalls.length > 0) {
    return renderToolCallEntry(toolCalls);
  }

  const div = document.createElement("div");
  div.className = "tail-entry entry-assistant";

  const label = document.createElement("div");
  label.className = "tail-label";
  label.textContent = "assistant";
  div.appendChild(label);

  for (const block of blocks) {
    if (block.type === "thinking" && block.thinking?.trim()) {
      const el = document.createElement("div");
      el.className = "entry-thinking";
      const text = block.thinking!;
      el.textContent = text.length > 500 ? text.slice(0, 500) + " …" : text;
      div.appendChild(el);
    } else if (block.type === "text" && block.text?.trim()) {
      const el = document.createElement("div");
      el.className = "tail-body";
      const text = block.text!;
      el.textContent = text.length > 2000 ? text.slice(0, 2000) + " …" : text;
      div.appendChild(el);
    }
    // Mixed text+toolCall entries: tool cards rendered inline after text
  }

  // Inline tool calls when mixed with text
  if (toolCalls.length > 0) {
    div.appendChild(renderToolCallEntry(toolCalls));
  }

  if (entry.message?.stopReason === "aborted" || entry.message?.stopReason === "error") {
    const err = document.createElement("div");
    err.style.color = "#fc3a4b";
    err.textContent = entry.message.stopReason === "aborted"
      ? "Aborted"
      : `Error: ${entry.message.errorMessage ?? "unknown"}`;
    div.appendChild(err);
  }

  return div;
}

// ── Tool call card(s) ──────────────────────────────────────────────────

function renderToolCallEntry(toolCalls: ContentBlock[]): HTMLElement {
  const frag = document.createElement("div");
  for (const block of toolCalls) {
    const name = block.name ?? "tool";
    const isEdit = name in CONTENT_TOOLS;
    const args = blockArgs(block);

    const card = document.createElement("div");
    card.className = "tail-entry entry-tool collapsed";

    const label = document.createElement("div");
    label.className = "tail-label";
    label.innerHTML = `<span class="tool-icon"></span>${escapeHtml(name)}`;
    card.appendChild(label);

    if (!isEdit && args !== undefined) {
      const preview = document.createElement("div");
      preview.className = "tail-preview";
      preview.textContent = truncLines(JSON.stringify(args, null, 2), PREVIEW_LINES);
      card.appendChild(preview);
    }

    const full = document.createElement("div");
    full.className = "tail-body tail-full";
    const fullText = args !== undefined ? JSON.stringify(args, null, 2) : "";
    full.textContent = fullText.length > 4000 ? fullText.slice(0, 4000) + " …" : fullText;
    card.appendChild(full);

    card.addEventListener("click", () => card.classList.toggle("collapsed"));
    frag.appendChild(card);
  }
  return frag.children.length === 1 ? frag.children[0] as HTMLElement : frag;
}

// ── Tool result ─────────────────────────────────────────────────────────

function renderToolResultEntry(entry: SessionEntry): HTMLElement {
  const msg = entry.message!;
  const content = msg.content;
  const isError = msg.isError === true;
  const toolName = msg.toolName ?? "result";

  const card = document.createElement("div");
  card.className = `tail-entry entry-tool collapsed${isError ? " error" : ""}`;

  const label = document.createElement("div");
  label.className = "tail-label";
  label.innerHTML = `<span class="tool-icon"></span>${escapeHtml(toolName)}`;
  card.appendChild(label);

  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as ContentBlock[])
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("")
      .trim() || "[tool result]";
  } else {
    text = "[tool result]";
  }

  const preview = document.createElement("div");
  preview.className = "tail-preview";
  preview.textContent = truncLines(text, PREVIEW_LINES);
  card.appendChild(preview);

  const full = document.createElement("div");
  full.className = "tail-body tail-full";
  full.textContent = text.length > 4000 ? text.slice(0, 4000) + " …" : text;
  card.appendChild(full);

  card.addEventListener("click", () => card.classList.toggle("collapsed"));
  return card;
}

// ── User message ────────────────────────────────────────────────────────

function renderUserEntry(entry: SessionEntry): HTMLElement {
  const div = document.createElement("div");
  div.className = "tail-entry entry-user";

  const label = document.createElement("div");
  label.className = "tail-label";
  label.textContent = "user";
  div.appendChild(label);

  const content = entry.message!.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as ContentBlock[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
      : "";
  if (text.trim()) {
    const body = document.createElement("div");
    body.className = "tail-body";
    body.textContent = text.length > 2000 ? text.slice(0, 2000) + " …" : text;
    div.appendChild(body);
  }
  return div;
}

// ── System / meta entries ───────────────────────────────────────────────

function renderSystemEntry(entry: SessionEntry): HTMLElement {
  const div = document.createElement("div");
  div.className = "tail-entry entry-system";

  if (entry.type === "compaction") {
    const tokens = entry.tokensBefore ? ` from ${Number(entry.tokensBefore).toLocaleString()} tokens` : "";
    div.textContent = `[compaction${tokens}]`;
  } else if (entry.type === "model_change") {
    div.textContent = `Switched to model: ${entry.model ?? "unknown"}`;
  } else if (entry.type === "thinking_level_change") {
    div.textContent = `Thinking level: ${(entry as Record<string, unknown>).thinkingLevel ?? "default"}`;
  } else if (entry.type === "custom_message") {
    const ct = (entry as Record<string, unknown>).customType as string | undefined;
    div.textContent = ct ? `[${ct}]` : "[custom message]";
  } else {
    div.textContent = `[${entry.type}]`;
  }
  return div;
}

// ── Dispatch ────────────────────────────────────────────────────────────

function renderEntry(entry: SessionEntry): HTMLElement {
  if (entry.type === "message" && entry.message) {
    const role = entry.message.role;
    if (role === "user" || role === "developer") return renderUserEntry(entry);
    if (role === "assistant") return renderAssistantEntry(entry);
    if (role === "toolResult") return renderToolResultEntry(entry);
  }
  return renderSystemEntry(entry);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Viewer ──────────────────────────────────────────────────────────────

/** Max entries retained in memory (tail window for scroll-back). */
const MAX_BUFFERED = INITIAL_TAIL + PAGE_SIZE * 20; // 880

export class CollabTailViewer {
  #container: HTMLElement;
  #key: CryptoKey | null = null;
  #ws: WebSocket | null = null;
  #allEntries: SessionEntry[] = [];
  #totalReceived = 0;
  #renderedCount = 0;
  #snapshotDone = false;
  #header: Record<string, unknown> | null = null;
  #state: Record<string, unknown> | null = null;
  #statusEl: HTMLElement;
  #scrollEl: HTMLElement;
  #contentEl: HTMLElement;
  #loadMoreEl: HTMLElement;
  #destroyed = false;
  /** Serializes async message processing so frames are handled in order. */
  #msgQueue: Promise<void> = Promise.resolve();

  constructor(container: HTMLElement) {
    this.#container = container;
    this.#container.innerHTML = "";
    this.#container.className = "tail-viewer";

    this.#statusEl = document.createElement("div");
    this.#statusEl.className = "tail-status";
    this.#statusEl.textContent = "Connecting…";
    this.#container.appendChild(this.#statusEl);

    this.#scrollEl = document.createElement("div");
    this.#scrollEl.className = "tail-scroll";
    this.#container.appendChild(this.#scrollEl);

    this.#loadMoreEl = document.createElement("div");
    this.#loadMoreEl.className = "tail-load-more";
    this.#loadMoreEl.style.display = "none";
    this.#loadMoreEl.textContent = "▲ Load earlier messages";
    this.#loadMoreEl.addEventListener("click", () => this.#loadMore());
    this.#scrollEl.appendChild(this.#loadMoreEl);

    this.#contentEl = document.createElement("div");
    this.#contentEl.className = "tail-content";
    this.#scrollEl.appendChild(this.#contentEl);

    this.#scrollEl.addEventListener("scroll", () => {
      if (this.#scrollEl.scrollTop < 50 && this.#renderedCount < this.#allEntries.length) {
        this.#loadMore();
      }
    });
  }

  async connect(link: string): Promise<void> {
    const parsed = parseCollabLink(link);
    if (!parsed) {
      this.#statusEl.textContent = "Invalid Collab link";
      return;
    }
    this.#key = await importKey(parsed.key);
    this.#statusEl.textContent = "Connecting to relay…";

    const ws = new WebSocket(`${parsed.wsUrl}?role=guest`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;

    ws.addEventListener("open", async () => {
      if (this.#destroyed || !this.#key) return;
      this.#statusEl.textContent = "Joining room…";
      const hello = await seal(this.#key, {
        t: "hello",
        proto: COLLAB_PROTO,
        name: "Dashboard",
      });
      ws.send(packEnvelope(0, hello));
    });

    ws.addEventListener("message", (event) => {
      // Chain every message onto a serial queue so decryption order is
      // preserved and we never race snapshot-chunk accumulation.
      this.#msgQueue = this.#msgQueue.then(() => this.#onMessage(event));
    });

    ws.addEventListener("close", () => {
      if (!this.#destroyed) {
        this.#statusEl.textContent = "Disconnected";
        this.#statusEl.className = "tail-status warning";
      }
    });

    ws.addEventListener("error", () => {
      if (!this.#destroyed) {
        this.#statusEl.textContent = "Connection error";
        this.#statusEl.className = "tail-status warning";
      }
    });
  }

  async #onMessage(event: MessageEvent): Promise<void> {
    if (this.#destroyed || !this.#key) return;
    const raw = event.data;
    if (typeof raw === "string") {
      try {
        const ctrl = JSON.parse(raw);
        if (ctrl.t === "room-closed") {
          this.#statusEl.textContent = "Session ended";
          this.#statusEl.className = "tail-status warning";
        }
      } catch { /* ignore */ }
      return;
    }
    const data = new Uint8Array(raw as ArrayBuffer);
    if (data.byteLength <= ENVELOPE_HEADER) return;
    const payload = data.subarray(ENVELOPE_HEADER);
    let frame: Record<string, unknown>;
    try {
      frame = await unseal(this.#key, payload);
    } catch {
      return;
    }
    this.#handleFrame(frame);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#ws?.close();
    this.#ws = null;
    this.#allEntries = [];
    this.#renderedCount = 0;
  }

  #handleFrame(frame: Record<string, unknown>): void {
    const t = frame.t as string;
    switch (t) {
      case "welcome":
        this.#header = (frame.header as Record<string, unknown>) ?? null;
        this.#state = (frame.state as Record<string, unknown>) ?? null;
        this.#updateStatus();
        break;
      case "snapshot-chunk": {
        const entries = frame.entries as SessionEntry[] | undefined;
        if (entries) {
          // Append without spread to avoid blowing the stack on huge chunks.
          for (let i = 0; i < entries.length; i++) this.#allEntries.push(entries[i]);
          this.#totalReceived += entries.length;
          // Trim head if buffer exceeds cap — we only need the tail.
          if (this.#allEntries.length > MAX_BUFFERED * 1.5) {
            this.#allEntries = this.#allEntries.slice(-MAX_BUFFERED);
          }
        }
        this.#updateStatus();
        if (frame.final) {
          this.#snapshotDone = true;
          this.#renderTail();
          this.#updateStatus();
        }
        break;
      }
      case "entry": {
        const entry = frame.entry as SessionEntry | undefined;
        if (entry) {
          this.#allEntries.push(entry);
          this.#totalReceived++;
          if (this.#snapshotDone) {
            const wasAtBottom = this.#isNearBottom();
            this.#renderedCount++;
            this.#contentEl.appendChild(renderEntry(entry));
            if (wasAtBottom) this.#forceScrollBottom();
            this.#updateLoadMore();
          }
        }
        break;
      }
      case "state":
        this.#state = frame.state as Record<string, unknown>;
        this.#updateStatus();
        break;
      case "bye":
        this.#statusEl.textContent = `Session ended: ${frame.reason ?? ""}`;
        this.#statusEl.className = "tail-status warning";
        break;
      case "error":
        this.#statusEl.textContent = `Error: ${frame.message ?? "unknown"}`;
        this.#statusEl.className = "tail-status warning";
        break;
    }
  }

  #renderTail(): void {
    this.#contentEl.innerHTML = "";
    const total = this.#allEntries.length;
    const start = Math.max(0, total - INITIAL_TAIL);
    this.#renderedCount = total - start;
    for (let i = start; i < total; i++) {
      this.#contentEl.appendChild(renderEntry(this.#allEntries[i]));
    }
    this.#updateLoadMore();
    // Scroll to bottom once the container actually has layout dimensions.
    // ResizeObserver fires when the element first gets a non-zero size
    // (covers insertion into DOM, CSS resolution, reflow). Timeouts are
    // belts-and-suspenders for edge cases.
    this.#forceScrollBottom();
    const obs = new ResizeObserver(() => {
      this.#forceScrollBottom();
      obs.disconnect();
    });
    obs.observe(this.#scrollEl);
    setTimeout(() => { this.#forceScrollBottom(); obs.disconnect(); }, 500);
  }

  #loadMore(): void {
    const total = this.#allEntries.length;
    const alreadyShown = this.#renderedCount;
    const remaining = total - alreadyShown;
    if (remaining <= 0) return;

    const saveScrollHeight = this.#scrollEl.scrollHeight;
    const page = Math.min(PAGE_SIZE, remaining);
    const start = remaining - page;
    const frag = document.createDocumentFragment();
    for (let i = start; i < start + page; i++) {
      frag.appendChild(renderEntry(this.#allEntries[i]));
    }
    this.#contentEl.prepend(frag);
    this.#renderedCount += page;
    this.#scrollEl.scrollTop += this.#scrollEl.scrollHeight - saveScrollHeight;
    this.#updateLoadMore();
  }

  #updateLoadMore(): void {
    const remaining = this.#allEntries.length - this.#renderedCount;
    if (remaining > 0) {
      this.#loadMoreEl.style.display = "block";
      this.#loadMoreEl.textContent = `▲ Load earlier (${remaining} more)`;
    } else {
      this.#loadMoreEl.style.display = "none";
    }
  }

  /** True when the scroll position is within 80px of the bottom. */
  #isNearBottom(): boolean {
    const el = this.#scrollEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  #forceScrollBottom(): void {
    this.#scrollEl.scrollTop = this.#scrollEl.scrollHeight;
  }

  #updateStatus(): void {
    if (!this.#snapshotDone) {
      this.#statusEl.textContent = `Loading session (${this.#totalReceived} entries)…`;
      return;
    }
    const parts: string[] = [];
    if (this.#header) {
      const name = this.#header.sessionName ?? this.#header.name;
      if (typeof name === "string") parts.push(name);
    }
    if (this.#state) {
      const model = this.#state.model as { id?: string } | undefined;
      if (model?.id) parts.push(model.id);
      if (this.#state.inputRequired) parts.push("⏸ awaiting input");
      else if (this.#state.streaming) parts.push("▶ streaming");
    }
    parts.push(`${this.#totalReceived} entries`);
    this.#statusEl.textContent = parts.join(" · ");
    this.#statusEl.className = "tail-status ok";
  }
}