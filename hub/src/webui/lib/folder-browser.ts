import { button, el } from "./dom";

interface FolderListing {
  path: string;
  entries: string[];
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

export class FolderBrowser {
  readonly element = el("div", { className: "folder-browser" });
  readonly #toggle = button("Browse folders", "small");
  readonly #panel = el("div", { className: "folder-panel" });
  readonly #location = el("p", { className: "folder-location" });
  readonly #up = button("Up", "small");
  readonly #list = el("div", { className: "folder-list" });
  readonly #status = el("p", { className: "folder-status" });
  readonly #folderName = document.createElement("input");
  readonly #create = button("Create folder", "small");
  readonly #suggestions = document.createElement("datalist");
  #host = "";
  #current = "";
  #request = 0;
  #generation = 0;
  #completionRequest = 0;
  #completionCache: { parent: string; listing: FolderListing } | undefined;
  #canCreate = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly path: HTMLInputElement) {
    this.#panel.hidden = true;
    this.#panel.id = "folder-browser-panel";
    this.#toggle.setAttribute("aria-expanded", "false");
    this.#toggle.setAttribute("aria-controls", this.#panel.id);
    this.#toggle.onclick = () => {
      if (!this.#panel.hidden) {
        this.#hide();
      } else {
        this.#panel.hidden = false;
        this.#toggle.setAttribute("aria-expanded", "true");
        void this.#browse(this.path.value || "");
      }
    };
    const navigation = el("div", { className: "folder-navigation" });
    const home = button("Home", "small");
    home.onclick = () => void this.#browse("");
    this.#up.onclick = () => {
      const parent = this.#current.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
      void this.#browse(parent);
    };
    navigation.append(home, this.#up, this.#location);
    this.#list.setAttribute("aria-label", "Folders");
    this.#status.setAttribute("role", "status");
    const createRow = el("div", { className: "folder-create" });
    this.#folderName.placeholder = "Folder name";
    this.#folderName.setAttribute("aria-label", "New folder name");
    this.#folderName.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.#createFolder();
      }
    };
    this.#create.onclick = () => void this.#createFolder();
    createRow.append(this.#folderName, this.#create);
    this.#panel.append(navigation, this.#list, createRow, this.#status);
    this.#suggestions.id = "folder-path-suggestions";
    this.path.setAttribute("list", this.#suggestions.id);
    this.path.setAttribute("autocomplete", "off");
    this.path.addEventListener("input", () => {
      clearTimeout(this.#timer);
      const request = ++this.#completionRequest;
      this.#suggestions.replaceChildren();
      this.#timer = setTimeout(() => void this.#complete(request), 250);
    });
    this.element.append(this.#toggle, this.#panel, this.#suggestions);
  }

  reset(host: string): void {
    this.#host = host;
    ++this.#generation;
    this.#current = "";
    this.#canCreate = false;
    this.#completionCache = undefined;
    this.#hide();
    ++this.#completionRequest;
    clearTimeout(this.#timer);
    this.#suggestions.replaceChildren();
    this.#folderName.value = "";
    this.#status.textContent = "";
  }

  setDisabled(disabled: boolean): void {
    this.#toggle.disabled = disabled;
    this.#create.disabled = disabled || !this.#canCreate;
    if (disabled) this.#hide();
  }

  #hide(): void {
    ++this.#request;
    this.#panel.hidden = true;
    this.#toggle.setAttribute("aria-expanded", "false");
  }

  async #fetch(path: string, init?: RequestInit): Promise<FolderListing> {
    const response = await fetch(`/api/hosts/${encodeURIComponent(this.#host)}/folders${init ? "" : `?path=${encodeURIComponent(path)}`}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body as FolderListing;
  }

  async #browse(path: string): Promise<void> {
    const request = ++this.#request;
    this.#current = path;
    this.#canCreate = false;
    if (this.#list.contains(document.activeElement)) this.#up.focus();
    this.#status.textContent = "Loading folders…";
    this.#list.replaceChildren();
    this.#create.disabled = true;
    try {
      const listing = await this.#fetch(path);
      if (request !== this.#request) return;
      this.#current = listing.path;
      this.#location.textContent = listing.path;
      this.#location.title = listing.path;
      const select = button("Select this folder", "small");
      select.onclick = () => {
        this.path.value = listing.path;
        ++this.#completionRequest;
        clearTimeout(this.#timer);
        this.#suggestions.replaceChildren();
        this.#hide();
        this.path.focus();
      };
      this.#list.append(select);
      for (const name of listing.entries) {
        const entry = button(name, "folder-entry");
        entry.onclick = () => void this.#browse(joinPath(listing.path, name));
        this.#list.append(entry);
      }
      this.#status.textContent = listing.entries.length ? "" : "No subfolders.";
      this.#canCreate = true;
      this.#create.disabled = false;
    } catch (error) {
      if (request !== this.#request) return;
      this.#location.textContent = path || "Home";
      this.#location.title = path || "Home";
      this.#status.textContent = (error as Error).message;
    }
  }

  async #createFolder(): Promise<void> {
    const name = this.#folderName.value.trim();
    if (!name || name === "." || name === ".." || name.includes("/")) {
      this.#status.textContent = "Enter a folder name without slashes.";
      return;
    }
    if (this.#create.disabled) return;
    const generation = this.#generation;
    this.#canCreate = false;
    const request = ++this.#request;
    const path = joinPath(this.#current, name);
    this.#create.disabled = true;
    this.#status.textContent = "Creating folder…";
    try {
      await this.#fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      if (generation === this.#generation) {
        this.#completionCache = undefined;
        ++this.#completionRequest;
        clearTimeout(this.#timer);
        this.#suggestions.replaceChildren();
      }
      if (request !== this.#request) return;
      this.#folderName.value = "";
      await this.#browse(path);
    } catch (error) {
      if (request !== this.#request) return;
      this.#status.textContent = (error as Error).message;
      this.#canCreate = true;
      this.#create.disabled = false;
    }
  }

  async #complete(request: number): Promise<void> {
    const value = this.path.value;
    const slash = value.lastIndexOf("/");
    if (slash < 0 || (!value.startsWith("/") && !value.startsWith("~/"))) return;
    const parent = slash === 0 ? "/" : value.slice(0, slash);
    const prefix = value.slice(slash + 1);
    try {
      const listing = this.#completionCache?.parent === parent
        ? this.#completionCache.listing
        : await this.#fetch(parent);
      if (request !== this.#completionRequest) return;
      this.#completionCache = { parent, listing };
      this.#suggestions.replaceChildren(...listing.entries.filter((name) => name.startsWith(prefix)).map((name) => {
        const option = document.createElement("option");
        option.value = `${value.slice(0, slash + 1)}${name}`;
        return option;
      }));
    } catch {
      // The path remains editable when a host cannot list folders.
    }
  }
}
