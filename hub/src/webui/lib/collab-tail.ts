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

interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

/** Flatten content blocks into a single text string. */
function entryText(entry: SessionEntry): string {
  const msg = entry.message;
  if (!msg) return `[${entry.type}]`;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" ? (block.text ?? "") : `[${block.type ?? "block"}]`,
      )
      .join("");
  }
  return JSON.stringify(content);
}

function roleClass(role: string | undefined): string {
  switch (role) {
    case "assistant":
      return "entry-assistant";
    case "user":
      return "entry-user";
    case "tool":
      return "entry-tool";
    default:
      return "entry-other";
  }
}

function roleLabel(entry: SessionEntry): string {
  const role = entry.message?.role;
  if (role === "assistant") return "π";
  if (role === "user") return "▸";
  if (role === "tool") return "⚙";
  if (entry.type === "compaction_summary") return "⋯";
  return "·";
}

function renderEntry(entry: SessionEntry): HTMLElement {
  const role = entry.message?.role;
  const div = document.createElement("div");
  div.className = `tail-entry ${roleClass(role)}`;

  const label = document.createElement("span");
  label.className = "tail-role";
  label.textContent = roleLabel(entry);
  div.appendChild(label);

  const body = document.createElement("span");
  body.className = "tail-body";
  const text = entryText(entry);
  // Show first 2000 chars; tool results and long outputs get truncated.
  body.textContent = text.length > 2000 ? text.slice(0, 2000) + " …" : text;
  div.appendChild(body);

  return div;
}

// ─── Viewer ──────────────────────────────────────────────────────────────

export class CollabTailViewer {
  #container: HTMLElement;
  #key: CryptoKey | null = null;
  #ws: WebSocket | null = null;
  #allEntries: SessionEntry[] = [];
  #renderedCount = 0;
  #snapshotDone = false;
  #header: Record<string, unknown> | null = null;
  #state: Record<string, unknown> | null = null;
  #statusEl: HTMLElement;
  #scrollEl: HTMLElement;
  #contentEl: HTMLElement;
  #loadMoreEl: HTMLElement;
  #destroyed = false;

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

    // Lazy-load on scroll to top
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

    ws.addEventListener("message", async (event) => {
      if (this.#destroyed || !this.#key) return;
      const raw = event.data;
      if (typeof raw === "string") {
        // Control frame from relay (JSON text)
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
        return; // decrypt failure — skip
      }
      this.#handleFrame(frame);
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
        if (entries) this.#allEntries.push(...entries);
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
          // Append live entry directly
          if (this.#snapshotDone) {
            this.#renderedCount++;
            this.#contentEl.appendChild(renderEntry(entry));
            this.#scrollToBottom();
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
    this.#scrollToBottom();
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
    // Preserve scroll position after prepending
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

  #scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.#scrollEl.scrollTop = this.#scrollEl.scrollHeight;
    });
  }

  #updateStatus(): void {
    if (!this.#snapshotDone) {
      this.#statusEl.textContent = `Loading session (${this.#allEntries.length} entries)…`;
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
    parts.push(`${this.#allEntries.length} entries`);
    this.#statusEl.textContent = parts.join(" · ");
    this.#statusEl.className = "tail-status ok";
  }
}