// Standalone single-session page (/s/): resolves a share link (see
// lib/share-link.ts) to the live Collab room for that session and shows the
// full control guest edge to edge, so it can sit in an iframe on another page.
// Resolution happens on every load, and again whenever the session goes away,
// so the link keeps working across omp restarts.

import { collabFrameUrl } from "./lib/collab-link";
import { customizeCollabFrame } from "./lib/collab-frame";
import {
  type ShareCandidate,
  type ShareTarget,
  labelSuffix,
  matchSession,
  parseShareUrl,
} from "./lib/share-link";

// Escape inside the nested guest cannot bubble into the embedding document.
// Forward an unhandled Escape so an embedding page can close its chat UI.
function requestCloseOnEscape(event: KeyboardEvent): void {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    window.parent === window
  )
    return;
  window.parent.postMessage({ type: "ompc:close-chat" }, "*");
}

interface LiveSession extends ShareCandidate {
  generation: number;
}

const POLL_MS = 3000;
const LAUNCH_WAIT_MS = 90_000;

const statusBox = document.querySelector<HTMLElement>(
  "[data-status]",
) as HTMLElement;
const statusText = document.querySelector<HTMLElement>(
  "[data-status-text]",
) as HTMLElement;
const startButton = document.querySelector<HTMLButtonElement>(
  "[data-retry]",
) as HTMLButtonElement;
const frame = document.querySelector<HTMLIFrameElement>(
  "[data-frame]",
) as HTMLIFrameElement;

function show(text: string, canStart = false): void {
  frame.hidden = true;
  frame.src = "about:blank";
  statusBox.hidden = false;
  statusText.textContent = text;
  startButton.hidden = !canStart;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(body.error || `Request failed (${response.status})`),
      {
        status: response.status,
      },
    );
  return body as T;
}

const target: ShareTarget | null = parseShareUrl(location.search);
if (!target) {
  show("This link is missing its host.");
} else {
  void run(target);
}

async function run(target: ShareTarget): Promise<void> {
  const hostPath = `/api/hosts/${encodeURIComponent(target.host)}`;
  let attached: { instanceId: string; generation: number } | undefined;
  let launchedAt = 0;
  // Only a page load or an explicit click starts a session; a session that
  // ends while the page is open is not silently restarted.
  let mayLaunch = true;

  async function attach(session: LiveSession): Promise<void> {
    const result = await api<{ access: string; url: string }>(
      `${hostPath}/collab/${encodeURIComponent(session.instanceId)}/link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation: session.generation,
          access: "control",
        }),
      },
    );
    if (result.access !== "control")
      throw new Error("Host did not grant control access");
    attached = {
      instanceId: session.instanceId,
      generation: session.generation,
    };
    statusBox.hidden = true;
    frame.hidden = false;
    frame.src = collabFrameUrl(result.url, location.origin);
  }

  async function launch(): Promise<void> {
    if (!target?.cwd)
      throw new Error(
        "This link has no working directory to start a session in.",
      );
    launchedAt = Date.now();
    mayLaunch = false;
    show("Starting session…");
    try {
      await api(`${hostPath}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: target.cwd,
          name: labelSuffix(target.label, target.cwd),
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        }),
      });
    } catch (error) {
      // 409: the label is already live, so discovery will find it.
      if ((error as { status?: number }).status !== 409) throw error;
    }
  }

  async function tick(): Promise<void> {
    if (!target) return;
    try {
      const { sessions } = await api<{ sessions: LiveSession[] }>(
        `${hostPath}/collab`,
      );
      const match = matchSession(sessions, target);
      if (match) {
        if (
          attached?.instanceId !== match.instanceId ||
          attached.generation !== match.generation
        )
          await attach(match);
        return;
      }
      if (attached) {
        attached = undefined;
        show("Session ended.", Boolean(target.cwd));
        return;
      }
      if (mayLaunch && target.cwd) await launch();
      else if (launchedAt && Date.now() - launchedAt > LAUNCH_WAIT_MS)
        show("The session did not start.", Boolean(target.cwd));
      else if (!launchedAt)
        show("Waiting for the session…", Boolean(target.cwd));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) show("Host is not connected. Waiting…");
      else if (!attached) show((error as Error).message, Boolean(target.cwd));
    }
  }

  startButton.onclick = () => {
    mayLaunch = true;
    void tick();
  };
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (doc?.head && doc.location.href !== "about:blank") {
      customizeCollabFrame(doc, localStorage);
      doc.addEventListener("keydown", requestCloseOnEscape);
    }
  });
  document.addEventListener("keydown", requestCloseOnEscape);
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
