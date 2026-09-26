// The inspector's Files tab: browse, download, preview and upload files in
// the selected session's working directory.
//
// Like the Session tab, the pane is one persistent element tree that the
// dashboard re-attaches on each render. The listing is rebuilt only when a
// new listing arrives, and uploads keep their own rows (with progress) for
// their whole lifetime, so polling never resets navigation or progress.

import { button, copyText, el } from "./dom";
import {
  absolutePath,
  breadcrumbs,
  entryTarget,
  folderNameError,
  formatBytes,
  isPreviewableImage,
  joinPath,
  normalisePath,
} from "./file-paths";
import {
  ApiError,
  type FileEntry,
  type FileListing,
  LatestResponseGate,
  MAX_UPLOAD_BYTES,
  NEEDS_UPDATE_NOTE,
  VIEW_ONLY_FILES_NOTE,
  errorMessage,
  postJson,
  requestJson,
  sessionApiBase,
  supportsSessionV1,
} from "./session-api";
import type { PaneHost } from "./session-pane";
import { type CollabSession, sessionKey } from "./workspace";

type UploadState =
  | "queued"
  | "uploading"
  | "done"
  | "skipped"
  | "error"
  | "cancelled";

interface UploadItem {
  key: string;
  apiBase: string;
  dir: string;
  path: string;
  file: File;
  state: UploadState;
  xhr: XMLHttpRequest | null;
  row: HTMLElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  cancel: HTMLButtonElement;
}

interface UploadResponse {
  status: number;
  body: unknown;
}

export class FilesPane {
  readonly element: HTMLElement;
  readonly #host: PaneHost;
  readonly #cwdFor: (session: CollabSession) => string | undefined;
  readonly #gate = new LatestResponseGate();
  #session: CollabSession | null = null;
  #key: string | null = null;
  #path = "";
  #listing: FileListing | null = null;
  #renderedListing: FileListing | null = null;
  #loads = 0;
  #error: string | null = null;
  #blocked: "unsupported" | "view-only" | null = null;
  #preview: string | null = null;
  #active = false;
  #crumbSignature = "";
  #uploads: UploadItem[] = [];
  #uploading = false;

  readonly #empty: HTMLElement;
  readonly #note: HTMLElement;
  readonly #browser: HTMLElement;
  readonly #uploadButton: HTMLButtonElement;
  readonly #mkdirButton: HTMLButtonElement;
  readonly #refreshButton: HTMLButtonElement;
  readonly #fileInput: HTMLInputElement;
  readonly #crumbs: HTMLElement;
  readonly #errorLine: HTMLElement;
  readonly #list: HTMLElement;
  readonly #previewFigure: HTMLElement;
  readonly #previewImage: HTMLImageElement;
  readonly #previewCaption: HTMLElement;
  readonly #previewOpen: HTMLAnchorElement;
  readonly #uploadsSection: HTMLElement;
  readonly #uploadList: HTMLElement;
  readonly #clearUploads: HTMLButtonElement;
  readonly #dropHint: HTMLElement;

  constructor(
    host: PaneHost,
    cwdFor: (session: CollabSession) => string | undefined,
  ) {
    this.#host = host;
    this.#cwdFor = cwdFor;
    this.element = el("section", { className: "files-pane" });
    this.element.dataset.filesPane = "";
    this.#empty = el("p", { className: "empty", text: "Select a session." });
    this.#note = el("p", { className: "pane-note" });
    this.#note.setAttribute("role", "status");

    this.#uploadButton = button("Upload");
    this.#mkdirButton = button("New folder");
    this.#refreshButton = button("Refresh");
    this.#fileInput = document.createElement("input");
    this.#fileInput.type = "file";
    this.#fileInput.multiple = true;
    this.#fileInput.hidden = true;
    this.#fileInput.dataset.filesUploadInput = "";
    this.#uploadButton.addEventListener("click", () => this.#fileInput.click());
    this.#fileInput.addEventListener("change", () => {
      this.#enqueue([...(this.#fileInput.files ?? [])]);
      this.#fileInput.value = "";
    });
    this.#mkdirButton.addEventListener("click", () => void this.#mkdir());
    this.#refreshButton.addEventListener(
      "click",
      () => void this.load(this.#path),
    );
    const toolbar = el("div", { className: "files-toolbar" });
    toolbar.append(
      this.#uploadButton,
      this.#mkdirButton,
      this.#refreshButton,
      this.#fileInput,
    );

    this.#crumbs = el("ol", { className: "breadcrumb" });
    const crumbNav = el("nav");
    crumbNav.setAttribute("aria-label", "Folder");
    crumbNav.append(this.#crumbs);
    this.#errorLine = el("p", { className: "pane-note error" });
    this.#errorLine.setAttribute("role", "alert");
    this.#list = el("ul", { className: "file-list" });
    this.#list.setAttribute("aria-label", "Files");

    this.#previewFigure = el("figure", { className: "file-preview" });
    this.#previewImage = document.createElement("img");
    this.#previewImage.alt = "";
    this.#previewCaption = el("span", { className: "file-preview-name" });
    this.#previewOpen = document.createElement("a");
    this.#previewOpen.textContent = "Open";
    this.#previewOpen.target = "_blank";
    this.#previewOpen.rel = "noopener";
    const closePreview = button("Close");
    closePreview.addEventListener("click", () => {
      this.#preview = null;
      this.#renderPreview();
    });
    const caption = el("figcaption");
    caption.append(this.#previewCaption, this.#previewOpen, closePreview);
    this.#previewFigure.append(this.#previewImage, caption);

    this.#uploadsSection = el("div", { className: "uploads" });
    this.#uploadList = el("ul", { className: "upload-list" });
    this.#uploadList.setAttribute("aria-label", "Uploads");
    this.#clearUploads = button("Clear finished", "small");
    this.#clearUploads.addEventListener("click", () => {
      this.#uploads = this.#uploads.filter(
        (item) =>
          item.key !== this.#key ||
          item.state === "queued" ||
          item.state === "uploading",
      );
      this.#renderUploads();
    });
    const uploadsHeader = el("div", { className: "uploads-header" });
    uploadsHeader.append(el("h3", { text: "Uploads" }), this.#clearUploads);
    this.#uploadsSection.append(uploadsHeader, this.#uploadList);

    this.#browser = el("div", { className: "files-browser" });
    this.#browser.append(
      toolbar,
      crumbNav,
      this.#errorLine,
      this.#list,
      this.#previewFigure,
      this.#uploadsSection,
    );
    this.#dropHint = el("div", { className: "drop-hint" });
    this.element.append(
      el("h2", { text: "Files" }),
      this.#empty,
      this.#note,
      this.#browser,
      this.#dropHint,
    );
    this.#attachDropTarget();
    this.#render();
  }

  /** Called on every dashboard render; a different session resets the pane. */
  setSession(session: CollabSession | null): void {
    const key = session ? sessionKey(session) : null;
    const wasSupported = this.#session
      ? supportsSessionV1(this.#session)
      : false;
    this.#session = session;
    if (key !== this.#key) {
      this.#key = key;
      this.#path = "";
      this.#listing = null;
      this.#error = null;
      this.#blocked = null;
      this.#preview = null;
      this.#render();
      this.#renderUploads();
      if (this.#active) void this.load("");
      return;
    }
    this.#render();
    if (this.#active && !wasSupported && session && supportsSessionV1(session))
      void this.load(this.#path);
  }

  /** Lists the current directory whenever the tab comes into view. */
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    if (active) void this.load(this.#path);
  }

  async load(path: string): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key) return;
    if (!supportsSessionV1(session)) {
      this.#blocked = "unsupported";
      this.#render();
      return;
    }
    const target = normalisePath(path);
    const ticket = this.#gate.begin(key);
    this.#loads += 1;
    this.#render();
    let listing: FileListing;
    try {
      listing = await requestJson<FileListing>(
        `${this.#apiBase(session)}/files?path=${encodeURIComponent(target)}`,
      );
    } catch (error) {
      this.#loads -= 1;
      if (!this.#gate.accept(ticket, this.#key)) return this.#render();
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 404 && target !== "") {
        this.#host.showStatus(
          `${target} no longer exists; showing the session folder`,
          "warning",
        );
        return this.load("");
      }
      this.#listing = null;
      if (status === 403) this.#blocked = "view-only";
      else if (status === 501) this.#blocked = "unsupported";
      else this.#error = (error as Error).message;
      return this.#render();
    }
    this.#loads -= 1;
    if (!this.#gate.accept(ticket, this.#key)) return this.#render();
    this.#listing = listing;
    this.#path = listing.path;
    this.#error = null;
    this.#blocked = null;
    if (this.#preview && !this.#preview.startsWith(joinPath(this.#path, "")))
      this.#preview = null;
    this.#render();
  }

  #apiBase(session: CollabSession): string {
    return sessionApiBase(session.host_id, session.instanceId);
  }

  #cwd(): string {
    const session = this.#session;
    if (!session) return "";
    return this.#cwdFor(session) ?? session.cwd ?? "";
  }

  #canWrite(): boolean {
    return this.#listing !== null && this.#blocked === null;
  }

  #render(): void {
    const session = this.#session;
    this.#empty.hidden = session !== null;
    const note =
      this.#blocked === "unsupported"
        ? NEEDS_UPDATE_NOTE
        : this.#blocked === "view-only"
          ? VIEW_ONLY_FILES_NOTE
          : null;
    this.#note.hidden = !session || !note;
    this.#note.textContent = note ?? "";
    this.#browser.hidden = !session || note !== null;
    if (!session || note !== null) return;

    const canWrite = this.#canWrite();
    this.#uploadButton.disabled = !canWrite;
    this.#mkdirButton.disabled = !canWrite;
    this.#list.setAttribute("aria-busy", String(this.#loads > 0));
    this.#errorLine.hidden = !this.#error;
    this.#errorLine.textContent = this.#error ?? "";

    const crumbs = breadcrumbs(this.#cwd() || undefined, this.#path);
    const crumbSignature = JSON.stringify(crumbs);
    if (crumbSignature !== this.#crumbSignature) {
      this.#crumbSignature = crumbSignature;
      this.#crumbs.replaceChildren(
        ...crumbs.map((crumb, index) => {
          const item = el("li");
          if (index === crumbs.length - 1) {
            const current = el("span", { text: crumb.label });
            current.setAttribute("aria-current", "location");
            item.append(current);
          } else {
            const link = button(crumb.label, "crumb");
            link.addEventListener("click", () => void this.load(crumb.path));
            item.append(link);
          }
          return item;
        }),
      );
    }

    if (this.#listing !== this.#renderedListing) {
      this.#renderedListing = this.#listing;
      this.#renderListing();
    } else if (!this.#listing) {
      this.#list.replaceChildren(
        el("li", {
          className: "empty",
          text: this.#loads > 0 ? "Loading…" : "No listing.",
        }),
      );
    }
    this.#renderPreview();
  }

  #renderListing(): void {
    const listing = this.#listing;
    if (!listing) {
      this.#list.replaceChildren(
        el("li", {
          className: "empty",
          text: this.#loads > 0 ? "Loading…" : "No listing.",
        }),
      );
      return;
    }
    if (listing.entries.length === 0) {
      this.#list.replaceChildren(
        el("li", { className: "empty", text: "This folder is empty." }),
      );
      return;
    }
    this.#list.replaceChildren(
      ...listing.entries.map((entry) => this.#renderEntry(listing, entry)),
    );
  }

  #renderEntry(listing: FileListing, entry: FileEntry): HTMLElement {
    const session = this.#session as CollabSession;
    const path = joinPath(listing.path, entry.name);
    const target = entryTarget(entry);
    const row = el("li", { className: `file-row ${target ?? "other"}` });
    row.dataset.name = entry.name;
    let name: HTMLElement;
    if (target === "dir") {
      name = button(`${entry.name}/`, "file-name");
      name.addEventListener("click", () => void this.load(path));
    } else if (target === "file") {
      const link = document.createElement("a");
      link.className = "file-name";
      link.textContent = entry.name;
      link.href = `${this.#apiBase(session)}/files/download?path=${encodeURIComponent(path)}`;
      link.download = entry.name;
      name = link;
    } else {
      name = el("span", { className: "file-name", text: entry.name });
    }
    name.title = entry.name;

    const kind =
      entry.type === "symlink"
        ? target
          ? `Link to ${target === "dir" ? "folder" : "file"}`
          : "Link"
        : entry.type === "dir"
          ? "Folder"
          : entry.type === "other"
            ? "Special file"
            : formatBytes(entry.size);
    const modified = new Date(entry.mtimeMs).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
    const meta = el("span", {
      className: "file-meta",
      text: `${kind} · ${modified}`,
    });

    const actions = el("span", { className: "file-actions" });
    if (target === "file" && isPreviewableImage(entry.name)) {
      const preview = button("Preview", "small");
      preview.addEventListener("click", () => {
        this.#preview = path;
        this.#renderPreview();
        this.#previewFigure.scrollIntoView({ block: "nearest" });
      });
      actions.append(preview);
    }
    const copy = button("Copy path", "small");
    copy.addEventListener("click", () => void this.#copyPath(path));
    actions.append(copy);

    row.append(name, meta, actions);
    return row;
  }

  #renderPreview(): void {
    const session = this.#session;
    const path = this.#preview;
    this.#previewFigure.hidden = !session || !path;
    if (!session || !path) {
      this.#previewImage.removeAttribute("src");
      return;
    }
    const url = `${this.#apiBase(session)}/files/download?path=${encodeURIComponent(path)}&inline=1`;
    if (this.#previewImage.getAttribute("src") !== url) {
      this.#previewImage.src = url;
      this.#previewImage.alt = `Preview of ${path}`;
      this.#previewCaption.textContent = path.split("/").pop() ?? path;
      this.#previewOpen.href = url;
    }
  }

  async #copyPath(path: string): Promise<void> {
    const cwd = this.#cwd();
    const absolute = cwd ? absolutePath(cwd, path) : path;
    if (await copyText(absolute)) {
      this.#host.showStatus("Path copied", "ok");
      return;
    }
    window.prompt("Copy this path", absolute);
  }

  async #mkdir(): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key || !this.#canWrite()) return;
    const name = window.prompt("New folder name")?.trim();
    if (!name) return;
    const problem = folderNameError(name);
    if (problem) {
      this.#host.showStatus(problem, "warning");
      return;
    }
    const dir = this.#path;
    try {
      await postJson(`${this.#apiBase(session)}/files/mkdir`, {
        path: joinPath(dir, name),
      });
      this.#host.showStatus(`Created ${name}`, "ok");
    } catch (error) {
      this.#host.showStatus((error as Error).message, "warning");
    }
    if (this.#key === key && this.#path === dir) await this.load(dir);
  }

  #attachDropTarget(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files") ?? false;
    const setDragging = (dragging: boolean) => {
      this.element.classList.toggle("dragging", dragging);
      this.#dropHint.textContent = dragging
        ? `Drop to upload to ${this.#crumbs.lastElementChild?.textContent ?? "this folder"}`
        : "";
    };
    this.element.addEventListener("dragenter", (event) => {
      if (!hasFiles(event) || !this.#canWrite()) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    });
    this.element.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || !this.#canWrite()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.element.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    });
    this.element.addEventListener("drop", (event) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(event) || !this.#canWrite()) return;
      event.preventDefault();
      const files: File[] = [];
      let skipped = 0;
      for (const item of [...(event.dataTransfer?.items ?? [])]) {
        if (item.kind !== "file") continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) {
          skipped += 1;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (skipped > 0)
        this.#host.showStatus(
          "Folders cannot be uploaded; drop files",
          "warning",
        );
      this.#enqueue(files);
    });
  }

  #enqueue(files: File[]): void {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key || files.length === 0) return;
    for (const file of files) {
      const row = el("li", { className: "upload-row" });
      const name = el("span", { className: "upload-name", text: file.name });
      name.title = file.name;
      const status = el("span", { className: "upload-status" });
      const cancel = button("Cancel", "small");
      const progress = document.createElement("progress");
      progress.max = 1;
      progress.value = 0;
      row.append(name, status, cancel, progress);
      const item: UploadItem = {
        key,
        apiBase: this.#apiBase(session),
        dir: this.#path,
        path: joinPath(this.#path, file.name),
        file,
        state: "queued",
        xhr: null,
        row,
        progress,
        status,
        cancel,
      };
      row.dataset.uploadName = file.name;
      cancel.addEventListener("click", () => {
        if (item.state === "uploading") item.xhr?.abort();
        else if (item.state === "queued")
          this.#setUpload(item, "cancelled", "Cancelled");
      });
      if (file.size > MAX_UPLOAD_BYTES)
        this.#setUpload(item, "error", "Too large (limit 256 MB)");
      else this.#setUpload(item, "queued", "Queued");
      this.#uploads.push(item);
    }
    this.#renderUploads();
    void this.#pump();
  }

  #setUpload(item: UploadItem, state: UploadState, text: string): void {
    item.state = state;
    item.status.textContent = text;
    item.row.dataset.state = state;
    item.cancel.hidden = state !== "queued" && state !== "uploading";
    item.progress.hidden = state !== "uploading" && state !== "done";
    if (state === "done") item.progress.value = 1;
    this.#renderUploads();
  }

  #renderUploads(): void {
    const items = this.#uploads.filter((item) => item.key === this.#key);
    this.#uploadsSection.hidden = items.length === 0;
    this.#uploadList.replaceChildren(...items.map((item) => item.row));
    this.#clearUploads.hidden = !items.some(
      (item) => item.state !== "queued" && item.state !== "uploading",
    );
  }

  /** Uploads one file at a time; the hub caps concurrent transfers. */
  async #pump(): Promise<void> {
    if (this.#uploading) return;
    this.#uploading = true;
    try {
      for (;;) {
        const item = this.#uploads.find((upload) => upload.state === "queued");
        if (!item) return;
        await this.#upload(item);
        if (
          item.state === "done" &&
          item.key === this.#key &&
          item.dir === this.#path
        )
          await this.load(this.#path);
      }
    } finally {
      this.#uploading = false;
    }
  }

  async #upload(item: UploadItem): Promise<void> {
    let overwrite = false;
    for (;;) {
      this.#setUpload(item, "uploading", "Uploading 0%");
      item.progress.value = 0;
      const response = await this.#put(item, overwrite);
      if (response.status === 0) {
        this.#setUpload(
          item,
          item.state === "cancelled" ? "cancelled" : "error",
          item.state === "cancelled"
            ? "Cancelled"
            : "Upload failed: hub unreachable",
        );
        return;
      }
      if (response.status >= 200 && response.status < 300) {
        const size = (response.body as { size?: number } | null)?.size;
        this.#setUpload(
          item,
          "done",
          `Uploaded${typeof size === "number" ? ` (${formatBytes(size)})` : ""}`,
        );
        return;
      }
      if (response.status === 409 && !overwrite) {
        const where = item.dir ? item.dir : "the session folder";
        if (
          window.confirm(
            `"${item.file.name}" already exists in ${where}. Overwrite it?`,
          )
        ) {
          overwrite = true;
          continue;
        }
        this.#setUpload(
          item,
          "skipped",
          "Skipped; a file with that name exists",
        );
        return;
      }
      this.#setUpload(
        item,
        "error",
        response.status === 413
          ? "Too large (limit 256 MB)"
          : errorMessage(response.body, response.status),
      );
      return;
    }
  }

  #put(item: UploadItem, overwrite: boolean): Promise<UploadResponse> {
    const { promise, resolve } = Promise.withResolvers<UploadResponse>();
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open(
      "PUT",
      `${item.apiBase}/files/upload?path=${encodeURIComponent(item.path)}&overwrite=${overwrite ? 1 : 0}`,
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      const fraction = event.loaded / event.total;
      item.progress.value = fraction;
      item.status.textContent = `Uploading ${Math.floor(fraction * 100)}%`;
    });
    const finish = (status: number) => {
      item.xhr = null;
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve({ status, body });
    };
    xhr.addEventListener("load", () => finish(xhr.status));
    xhr.addEventListener("error", () => finish(0));
    xhr.addEventListener("abort", () => {
      item.state = "cancelled";
      finish(0);
    });
    xhr.send(item.file);
    return promise;
  }
}
