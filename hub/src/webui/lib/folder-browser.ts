import { button, el } from "./dom";

interface FolderListing {
  path: string;
  entries: string[];
}

interface FolderNode {
  path: string;
  row: HTMLElement;
  group: HTMLElement;
  select: HTMLButtonElement;
  expand: HTMLButtonElement;
  loaded: boolean;
  loading: boolean;
  version: number;
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

export class FolderBrowser {
  readonly element = el("div", { className: "folder-browser" });
  readonly #toggle = button("Browse folders", "small");
  readonly #panel = document.createElement("dialog");
  readonly #location = el("p", { className: "folder-location" });
  readonly #list = el("div", { className: "folder-list" });
  readonly #status = el("p", { className: "folder-status" });
  readonly #folderName = document.createElement("input");
  readonly #create = button("Create folder", "small");
  readonly #select = button("Select folder", "small");
  readonly #suggestions = document.createElement("datalist");
  #host = "";
  #selected: FolderNode | undefined;
  #request = 0;
  #generation = 0;
  #selectionRequest = 0;
  #completionRequest = 0;
  #completionCache: { parent: string; listing: FolderListing } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly path: HTMLInputElement) {
    this.#panel.className = "folder-panel";
    this.#panel.setAttribute("aria-labelledby", "folder-dialog-title");
    this.#toggle.setAttribute("aria-haspopup", "dialog");
    this.#toggle.onclick = () => {
      this.#panel.showModal();
      void this.#browse(this.path.value || "");
    };
    this.#panel.addEventListener("cancel", () => this.#invalidate());
    const heading = el("h2", { text: "Choose a folder" });
    heading.id = "folder-dialog-title";
    const home = button("Home", "small");
    home.onclick = () => void this.#browse("");
    const root = button("Root", "small");
    root.onclick = () => void this.#browse("/");
    const navigation = el("div", { className: "folder-navigation" });
    navigation.append(root, home, this.#location);
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
    this.#select.onclick = () => {
      if (!this.#selected) return;
      this.path.value = this.#selected.path;
      this.#clearCompletion();
      this.#hide();
      this.path.focus();
    };
    const cancel = button("Cancel", "small");
    cancel.onclick = () => this.#hide();
    const actions = el("div", { className: "folder-actions" });
    actions.append(cancel, this.#select);
    this.#panel.append(heading, navigation, this.#list, createRow, this.#status, actions);
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
    this.#completionCache = undefined;
    this.#hide();
    this.#clearCompletion();
    this.#folderName.value = "";
    this.#status.textContent = "";
  }

  setDisabled(disabled: boolean): void {
    this.#toggle.disabled = disabled;
    if (disabled) this.#hide();
  }

  #clearCompletion(): void {
    ++this.#completionRequest;
    clearTimeout(this.#timer);
    this.#suggestions.replaceChildren();
  }

  #invalidate(): void {
    ++this.#request;
    ++this.#selectionRequest;
    this.#selected = undefined;
  }

  #hide(): void {
    this.#invalidate();
    if (this.#panel.open) this.#panel.close();
  }

  async #fetch(path: string, init?: RequestInit): Promise<FolderListing> {
    const response = await fetch(`/api/hosts/${encodeURIComponent(this.#host)}/folders${init ? "" : `?path=${encodeURIComponent(path)}`}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body as FolderListing;
  }

  #node(path: string, label: string): FolderNode {
    const row = el("div", { className: "folder-row" });
    const expand = button("▸", "folder-expand");
    expand.setAttribute("aria-label", `Expand ${label}`);
    expand.setAttribute("aria-expanded", "false");
    const select = button(label, "folder-entry");
    const group = el("div", { className: "folder-children" });
    group.hidden = true;
    const node: FolderNode = { path, row, group, expand, select, loaded: false, loading: false, version: 0 };
    expand.onclick = () => {
      if (!group.hidden) {
        group.hidden = true;
        expand.textContent = "▸";
        expand.setAttribute("aria-expanded", "false");
        expand.setAttribute("aria-label", `Expand ${label}`);
      } else {
        group.hidden = false;
        expand.textContent = "▾";
        expand.setAttribute("aria-expanded", "true");
        expand.setAttribute("aria-label", `Collapse ${label}`);
        if (!node.loaded && !node.loading) void this.#load(node);
      }
    };
    select.onclick = () => void this.#choose(node);
    row.append(expand, select);
    return node;
  }

  async #load(node: FolderNode): Promise<boolean> {
    const request = this.#request;
    const version = ++node.version;
    node.loading = true;
    this.#status.textContent = "Loading folders…";
    try {
      const listing = await this.#fetch(node.path);
      if (request !== this.#request || version !== node.version) return false;
      node.path = listing.path;
      node.group.replaceChildren();
      for (const name of listing.entries) {
        const child = this.#node(joinPath(listing.path, name), name);
        node.group.append(child.row, child.group);
      }
      node.loaded = true;
      this.#status.textContent = listing.entries.length ? "" : "No subfolders.";
      return true;
    } catch (error) {
      if (request === this.#request && version === node.version) this.#status.textContent = (error as Error).message;
      return false;
    } finally {
      if (request === this.#request && version === node.version) node.loading = false;
    }
  }

  async #choose(node: FolderNode): Promise<void> {
    const selection = ++this.#selectionRequest;
    this.#selected?.select.removeAttribute("aria-pressed");
    this.#selected = undefined;
    this.#select.disabled = true;
    this.#create.disabled = true;
    this.#location.textContent = node.path;
    this.#location.title = node.path;
    // A separate request also validates an entry selected while its expansion is loading.
    if (!node.loaded && !await this.#load(node)) return;
    if (selection !== this.#selectionRequest) return;
    this.#status.textContent = node.group.children.length ? "" : "No subfolders.";
    this.#selected = node;
    node.select.setAttribute("aria-pressed", "true");
    this.#location.textContent = node.path;
    this.#location.title = node.path;
    this.#select.disabled = false;
    this.#create.disabled = false;
  }

  async #browse(path: string): Promise<void> {
    this.#invalidate();
    const request = this.#request;
    this.#select.disabled = true;
    this.#create.disabled = true;
    this.#location.textContent = path || "Home";
    this.#list.replaceChildren();
    this.#status.textContent = "Loading folders…";
    try {
      const listing = await this.#fetch(path);
      if (request !== this.#request) return;
      const parts = listing.path.split("/").filter(Boolean);
      const ancestors: FolderListing[] = [];
      if (listing.path.startsWith("/")) {
        for (let i = 0; i < parts.length; i++) {
          const ancestorPath = i ? `/${parts.slice(0, i).join("/")}` : "/";
          try {
            const ancestor = await this.#fetch(ancestorPath);
            if (request !== this.#request) return;
            if (ancestor.path !== ancestorPath || !ancestor.entries.includes(parts[i])) {
              ancestors.length = 0;
              break;
            }
            ancestors.push(ancestor);
          } catch {
            if (request !== this.#request) return;
            ancestors.length = 0;
            break;
          }
        }
      }
      let container = this.#list;
      let selected: FolderNode | undefined;
      for (const current of [...ancestors, listing]) {
        const label = current.path === "/" ? "/" : current.path.split("/").filter(Boolean).slice(-1)[0] || current.path;
        let node = selected;
        if (!node) {
          node = this.#node(current.path, label);
          container.append(node.row, node.group);
        }
        node.loaded = true;
        node.group.hidden = false;
        node.expand.textContent = "▾";
        node.expand.setAttribute("aria-expanded", "true");
        node.expand.setAttribute("aria-label", `Collapse ${label}`);
        const nextPath = ancestors[ancestors.indexOf(current) + 1]?.path ?? listing.path;
        selected = undefined;
        for (const name of current.entries) {
          const child = this.#node(joinPath(current.path, name), name);
          node.group.append(child.row, child.group);
          if (child.path === nextPath && current !== listing) selected = child;
        }
        container = node.group;
        if (current === listing) selected = node;
      }
      this.#status.textContent = listing.entries.length ? "" : "No subfolders.";
      if (selected) {
        await this.#choose(selected);
        if (request !== this.#request) return;
        const listRect = this.#list.getBoundingClientRect();
        const selectedRect = selected.row.getBoundingClientRect();
        if (selectedRect.top < listRect.top) {
          this.#list.scrollTop += selectedRect.top - listRect.top;
        } else if (selectedRect.bottom > listRect.bottom) {
          this.#list.scrollTop += selectedRect.bottom - listRect.bottom;
        }
      }
    } catch (error) {
      if (request === this.#request) this.#status.textContent = (error as Error).message;
    }
  }

  async #createFolder(): Promise<void> {
    const name = this.#folderName.value.trim();
    if (!name || name === "." || name === ".." || name.includes("/")) {
      this.#status.textContent = "Enter a folder name without slashes.";
      return;
    }
    const parent = this.#selected;
    if (this.#create.disabled || !parent) return;
    const generation = this.#generation;
    const request = this.#request;
    const selection = this.#selectionRequest;
    const path = joinPath(parent.path, name);
    this.#create.disabled = true;
    this.#status.textContent = "Creating folder…";
    try {
      await this.#fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      if (generation === this.#generation) {
        this.#completionCache = undefined;
        this.#clearCompletion();
      }
      if (request !== this.#request || selection !== this.#selectionRequest) return;
      this.#folderName.value = "";
      const child = this.#node(path, name);
      parent.group.append(child.row, child.group);
      if (parent.group.hidden) parent.expand.click();
      await this.#choose(child);
    } catch (error) {
      if (request !== this.#request || selection !== this.#selectionRequest) return;
      this.#status.textContent = (error as Error).message;
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
