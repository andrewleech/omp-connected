// The modal that shows a text file from the Files tab: rendered (Markdown and
// HTML) or raw, with a download link. Documents go into an iframe with an
// empty sandbox, see file-view.ts.

import { button, el } from "./dom";
import {
  type ViewKind,
  decodeText,
  renderHtmlDocument,
  renderMarkdownDocument,
  viewKind,
} from "./file-view";

export interface ViewTarget {
  /** File name, shown in the title. */
  name: string;
  /** Path relative to the session root. */
  path: string;
  /** Absolute URL prefix of the session's file API, with no trailing slash. */
  apiBase: string;
}

type Mode = "rendered" | "raw";

export class FileViewer {
  readonly #dialog: HTMLDialogElement;
  readonly #title: HTMLElement;
  readonly #modes: HTMLElement;
  readonly #renderedButton: HTMLButtonElement;
  readonly #rawButton: HTMLButtonElement;
  readonly #download: HTMLAnchorElement;
  readonly #body: HTMLElement;
  readonly #status: HTMLElement;
  readonly #raw: HTMLElement;
  readonly #frame: HTMLIFrameElement;
  #abort: AbortController | null = null;
  #kind: ViewKind = "text";

  constructor() {
    this.#dialog = el("dialog", {
      className: "file-viewer",
    }) as HTMLDialogElement;
    this.#dialog.dataset.fileViewer = "";
    this.#dialog.setAttribute("aria-labelledby", "file-viewer-title");
    this.#title = el("h2", { className: "file-viewer-title" });
    this.#title.id = "file-viewer-title";
    this.#renderedButton = button("Rendered", "small");
    this.#rawButton = button("Raw", "small");
    this.#renderedButton.addEventListener("click", () =>
      this.#setMode("rendered"),
    );
    this.#rawButton.addEventListener("click", () => this.#setMode("raw"));
    this.#modes = el("span", { className: "file-viewer-modes" });
    this.#modes.setAttribute("role", "group");
    this.#modes.setAttribute("aria-label", "View as");
    this.#modes.append(this.#renderedButton, this.#rawButton);
    this.#download = document.createElement("a");
    this.#download.className = "file-viewer-download";
    this.#download.textContent = "Download";
    const close = button("Close", "small");
    close.addEventListener("click", () => this.#dialog.close());
    const header = el("header", { className: "file-viewer-header" });
    header.append(this.#title, this.#modes, this.#download, close);

    this.#status = el("p", { className: "file-viewer-status" });
    this.#raw = el("pre", { className: "file-viewer-raw" });
    this.#raw.tabIndex = 0;
    this.#frame = document.createElement("iframe");
    this.#frame.className = "file-viewer-frame";
    this.#frame.title = "Rendered file";
    this.#frame.referrerPolicy = "no-referrer";
    // An empty sandbox: no scripts, forms, popups or same-origin access.
    this.#frame.setAttribute("sandbox", "");
    this.#body = el("div", { className: "file-viewer-body" });
    this.#body.append(this.#status, this.#raw, this.#frame);

    this.#dialog.append(header, this.#body);
    // A click on the backdrop lands on the dialog element itself.
    this.#dialog.addEventListener("click", (event) => {
      if (event.target === this.#dialog) this.#dialog.close();
    });
    this.#dialog.addEventListener("close", () => {
      this.#abort?.abort();
      this.#abort = null;
      this.#frame.removeAttribute("srcdoc");
      this.#raw.textContent = "";
    });
    document.body.append(this.#dialog);
  }

  /** Opens the file; a file that turns out not to be text is downloaded instead. */
  async open(target: ViewTarget): Promise<void> {
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const downloadUrl = `${target.apiBase}/files/download?path=${encodeURIComponent(target.path)}`;

    this.#title.textContent = target.name;
    this.#download.href = downloadUrl;
    this.#download.download = target.name;
    this.#kind = viewKind(target.name);
    this.#modes.hidden = this.#kind === "text";
    this.#raw.textContent = "";
    this.#frame.removeAttribute("srcdoc");
    this.#showStatus("Loading…");
    this.#rawButton.textContent = this.#kind === "html" ? "Source" : "Raw";
    if (!this.#dialog.open) this.#dialog.showModal();

    let text: string | null;
    try {
      const response = await fetch(downloadUrl, { signal: abort.signal });
      if (!response.ok) {
        const detail = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => undefined);
        throw new Error(detail ?? `HTTP ${response.status}`);
      }
      text = decodeText(await response.arrayBuffer());
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#showStatus(
        `Could not open ${target.name}: ${(error as Error).message}`,
      );
      return;
    }
    if (abort.signal.aborted) return;
    if (text === null) {
      this.#dialog.close();
      this.#startDownload(downloadUrl, target.name);
      return;
    }

    this.#raw.textContent = text;
    if (this.#kind === "markdown") {
      const dir = target.path.includes("/")
        ? target.path.slice(0, target.path.lastIndexOf("/"))
        : "";
      this.#frame.srcdoc = renderMarkdownDocument(text, target.name, {
        apiBase: target.apiBase,
        dir,
      });
    } else if (this.#kind === "html") {
      this.#frame.srcdoc = renderHtmlDocument(text);
    }
    this.#setMode(this.#kind === "text" ? "raw" : "rendered");
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close();
  }

  #setMode(mode: Mode): void {
    this.#status.hidden = true;
    this.#raw.hidden = mode !== "raw";
    this.#frame.hidden = mode !== "rendered";
    this.#renderedButton.setAttribute(
      "aria-pressed",
      String(mode === "rendered"),
    );
    this.#rawButton.setAttribute("aria-pressed", String(mode === "raw"));
    this.#renderedButton.classList.toggle("active", mode === "rendered");
    this.#rawButton.classList.toggle("active", mode === "raw");
  }

  #showStatus(message: string): void {
    this.#status.textContent = message;
    this.#status.hidden = false;
    this.#raw.hidden = true;
    this.#frame.hidden = true;
  }

  #startDownload(url: string, name: string): void {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }
}
