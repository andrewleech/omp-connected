import { el } from "./dom";
import {
  ApiError,
  LatestResponseGate,
  MODEL_ROLES_FEATURE,
  type ModelRoleInfo,
  type ModelRolesInfo,
  type RoleModel,
  modelRolesApiUrl,
  postJson,
  requestJson,
} from "./session-api";
import { type PaneHost, SESSION_REFRESH_MS } from "./session-pane";
import { type CollabSession, sessionKey } from "./workspace";

export class ModelRolesPane {
  readonly element: HTMLElement;
  readonly #host: PaneHost;
  readonly #gate = new LatestResponseGate();
  readonly #empty: HTMLElement;
  readonly #note: HTMLElement;
  readonly #list: HTMLElement;
  readonly #editor: HTMLElement;
  readonly #selector: HTMLInputElement;
  readonly #search: HTMLInputElement;
  readonly #options: HTMLElement;
  readonly #thinking: HTMLSelectElement;
  readonly #effective: HTMLElement;
  readonly #scope: HTMLSelectElement;
  readonly #save: HTMLButtonElement;
  readonly #reset: HTMLButtonElement;
  #session: CollabSession | null = null;
  #key: string | null = null;
  #info: ModelRolesInfo | null = null;
  #active = false;
  #timer: number | undefined;
  #busy = false;
  #unsupported = false;
  #loadError: string | null = null;
  #actionError: string | null = null;
  #selectedRole: string | null = null;
  #roleSignature = "";
  #models: RoleModel[] = [];
  #modelOpen = false;
  #selectedModel = "";
  #dirty = false;

  constructor(host: PaneHost) {
    this.#host = host;
    this.element = el("section", { className: "model-roles-pane" });
    this.element.dataset.modelRolesPane = "";
    this.#empty = el("p", { className: "empty", text: "Select a session." });
    this.#note = el("p", { className: "pane-note" });
    this.#note.setAttribute("role", "status");
    this.#list = el("div", { className: "role-list" });
    this.#editor = el("section", { className: "role-editor" });
    this.#editor.hidden = true;

    this.#search = document.createElement("input");
    this.#search.type = "text";
    this.#search.placeholder = "Search eligible models";
    this.#search.setAttribute("aria-label", "Search eligible models");
    this.#search.setAttribute("role", "combobox");
    this.#search.setAttribute("aria-autocomplete", "list");
    this.#search.setAttribute("aria-expanded", "false");
    this.#options = el("div", { className: "model-options" });
    this.#options.setAttribute("role", "listbox");
    this.#search.addEventListener("focus", () => {
      this.#modelOpen = true;
      this.#renderOptions();
    });
    this.#search.addEventListener("input", () => {
      this.#modelOpen = true;
      this.#renderOptions();
    });
    this.#search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.#modelOpen = false;
        this.#renderOptions();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.#options
          .querySelector<HTMLButtonElement>("button:not([hidden])")
          ?.click();
      }
    });
    this.#selector = document.createElement("input");
    this.#selector.type = "text";
    this.#selector.readOnly = true;
    this.#selector.setAttribute("aria-label", "Model selector");
    this.#thinking = document.createElement("select");
    this.#thinking.setAttribute("aria-label", "Thinking level");
    this.#thinking.addEventListener("change", () => {
      const base = this.#selectedModel;
      this.#selector.value = base
        ? `${base}${this.#thinking.value ? `:${this.#thinking.value}` : ""}`
        : "";
      const role = this.#role();
      this.#dirty =
        !!role &&
        this.#selector.value !== (this.#assignmentForScope(role) ?? "");
      this.#updateButtons();
    });
    this.#scope = document.createElement("select");
    this.#scope.setAttribute("aria-label", "Configuration scope");
    this.#scope.addEventListener("change", () => {
      const role = this.#role();
      if (!role) return;
      this.#dirty = false;
      this.#seedEditor(role);
      this.#updateButtons();
    });
    this.#save = el("button", {
      type: "button",
      text: "Save",
    }) as HTMLButtonElement;
    this.#save.addEventListener("click", () => void this.#saveAssignment());
    this.#reset = el("button", {
      type: "button",
      text: "Reset",
    }) as HTMLButtonElement;
    this.#reset.addEventListener(
      "click",
      () => void this.#saveAssignment(true),
    );
    const modelField = el("label", { className: "field" });
    modelField.append(
      el("span", { className: "field-label", text: "Eligible model" }),
      this.#search,
      this.#options,
    );
    const selectorField = el("label", { className: "field" });
    selectorField.append(
      el("span", { className: "field-label", text: "Selector" }),
      this.#selector,
    );
    const thinkingField = el("label", { className: "field" });
    thinkingField.append(
      el("span", { className: "field-label", text: "Thinking" }),
      this.#thinking,
    );
    const scopeField = el("label", { className: "field" });
    scopeField.append(
      el("span", { className: "field-label", text: "Configuration scope" }),
      this.#scope,
    );
    this.#effective = el("p", { className: "role-effective-note" });
    this.#editor.append(
      this.#effective,
      modelField,
      selectorField,
      thinkingField,
      scopeField,
      this.#save,
      this.#reset,
    );
    this.element.append(
      el("h2", { text: "Model roles" }),
      this.#empty,
      this.#note,
      this.#list,
      this.#editor,
    );
    this.#update();
  }

  setSession(session: CollabSession | null): void {
    const key = session ? sessionKey(session) : null;
    const wasSupported =
      this.#session?.features?.includes(MODEL_ROLES_FEATURE) ?? false;
    this.#session = session;
    if (key !== this.#key) {
      this.#key = key;
      this.#gate.invalidate();
      this.#info = null;
      this.#loadError = null;
      this.#actionError = null;
      this.#unsupported = false;
      this.#busy = false;
      this.#selectedRole = null;
      this.#dirty = false;
      this.#editor.hidden = true;
      this.#models = [];
      this.#selectedModel = "";
      this.#modelOpen = false;
      this.#search.value = "";
      this.#roleSignature = "";
      this.#list.replaceChildren();
      this.#update();
      if (this.#active) void this.refresh();
      return;
    }
    this.#update();
    if (
      this.#active &&
      !wasSupported &&
      session?.features?.includes(MODEL_ROLES_FEATURE)
    )
      void this.refresh();
  }

  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    window.clearInterval(this.#timer);
    this.#timer = undefined;
    if (!active) return;
    void this.refresh();
    this.#timer = window.setInterval(() => {
      if (!this.#busy && document.visibilityState === "visible")
        void this.refresh();
    }, SESSION_REFRESH_MS);
  }

  async refresh(): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    if (!session || !key || !session.features?.includes(MODEL_ROLES_FEATURE))
      return;
    const ticket = this.#gate.begin(key);
    try {
      const info = await requestJson<ModelRolesInfo>(
        modelRolesApiUrl(session.host_id, session.instanceId),
      );
      if (!this.#gate.accept(ticket, this.#key)) return;
      this.#info = info;
      this.#loadError = null;
      this.#unsupported = false;
      if (
        this.#selectedRole &&
        !info.roles.some((role) => role.id === this.#selectedRole)
      ) {
        this.#selectedRole = null;
        this.#editor.hidden = true;
        this.#dirty = false;
      }
    } catch (error) {
      if (!this.#gate.accept(ticket, this.#key)) return;
      if (error instanceof ApiError && error.status === 501)
        this.#unsupported = true;
      else this.#loadError = (error as Error).message;
    }
    this.#update();
  }

  #role(): ModelRoleInfo | null {
    return (
      this.#info?.roles.find((role) => role.id === this.#selectedRole) ?? null
    );
  }

  #selectRole(role: ModelRoleInfo): void {
    this.#selectedRole = role.id;
    this.#dirty = false;
    this.#search.value = "";
    this.#modelOpen = false;
    this.#scope.replaceChildren(
      new Option("Global", "global"),
      ...(this.#info?.storage === "project"
        ? [new Option("Project", "project")]
        : []),
    );
    this.#scope.value = this.#info?.storage ?? "global";
    this.#seedEditor(role);
    this.#editor.hidden = false;
    this.#renderList();
    this.#updateButtons();
  }

  #assignmentForScope(role: ModelRoleInfo): string | null {
    return this.#scope.value === "project"
      ? role.projectSelector
      : role.globalSelector;
  }

  #modelSelection(
    selector: string | null,
    models: RoleModel[],
  ): { model: RoleModel; thinking: string } | null {
    if (!selector) return null;
    for (const model of models) {
      if (`${model.provider}/${model.id}` === selector)
        return { model, thinking: "" };
    }
    for (const model of models) {
      const identity = `${model.provider}/${model.id}`;
      if (!selector.startsWith(`${identity}:`)) continue;
      const thinking = selector.slice(identity.length + 1);
      if (model.thinkingLevels.includes(thinking)) return { model, thinking };
    }
    return null;
  }

  #seedEditor(role: ModelRoleInfo): void {
    this.#models = [...role.models].sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      b.name.localeCompare(a.name, undefined, { numeric: true }),
    );
    const assignment = this.#assignmentForScope(role);
    const selected = this.#modelSelection(assignment, role.models);
    this.#selector.value = assignment ?? "";
    this.#selectedModel = selected
      ? `${selected.model.provider}/${selected.model.id}`
      : "";
    this.#search.value = selected?.model.name ?? "";
    const levels = selected?.model.thinkingLevels ?? [];
    this.#thinking.replaceChildren(
      new Option("Default", ""),
      ...levels.map((level) => new Option(level, level)),
    );
    this.#thinking.value =
      selected && levels.includes(selected.thinking) ? selected.thinking : "";
    const scope = this.#scope.value;
    const inheritedScope = scope === "project" ? "global" : "project";
    const inheritedSelector =
      scope === "project" ? role.globalSelector : role.projectSelector;
    const layerAssignment = assignment
      ? `${scope} assignment: ${assignment}`
      : `No ${scope} assignment${inheritedSelector ? `; inherits ${inheritedScope} ${inheritedSelector}` : ""}`;
    const effectiveSelector =
      role.selector ?? role.projectSelector ?? role.globalSelector;
    this.#effective.textContent = `${layerAssignment}. Effective selector: ${effectiveSelector ?? "automatic / fallback"} (${role.provenance ?? "automatic / fallback"})`;
  }

  #renderList(): void {
    const info = this.#info;
    const signature = JSON.stringify([this.#selectedRole, info?.roles ?? []]);
    if (signature === this.#roleSignature) return;
    this.#roleSignature = signature;
    this.#list.replaceChildren(
      ...(info?.roles ?? []).map((role) => {
        const row = el("button", {
          type: "button",
          className: `role-row${role.id === this.#selectedRole ? " selected" : ""}`,
        }) as HTMLButtonElement;
        row.dataset.roleId = role.id;
        const display = role.resolvedModel
          ? `${role.resolvedModel.name} (${role.resolvedModel.provider}/${role.resolvedModel.id})`
          : "No model resolved";
        const label =
          role.name === role.id ? role.id : `${role.id} · ${role.name}`;
        row.append(
          el("strong", { className: "role-name", text: label }),
          el("span", {
            className: "role-effective",
            text:
              role.selector ??
              role.projectSelector ??
              role.globalSelector ??
              "Automatic assignment",
          }),
          el("span", { className: "role-resolved", text: display }),
          el("span", {
            className: "role-provenance",
            text: role.provenance ?? "Automatic / fallback",
          }),
        );
        row.addEventListener("click", () => this.#selectRole(role));
        return row;
      }),
    );
  }

  #renderOptions(): void {
    const query = this.#search.value.trim().toLowerCase();
    const matches = this.#models.filter((model) =>
      `${model.name} ${model.provider} ${model.id}`
        .toLowerCase()
        .includes(query),
    );
    this.#options.hidden =
      !this.#modelOpen ||
      this.#info?.access !== "control" ||
      !this.#session?.features?.includes(MODEL_ROLES_FEATURE) ||
      this.#busy ||
      this.#unsupported;
    this.#search.setAttribute("aria-expanded", String(!this.#options.hidden));
    this.#options.replaceChildren(
      ...matches.map((model) => {
        const option = el("button", {
          type: "button",
          className: "model-option",
          text: `${model.name} (${model.provider}/${model.id})`,
        }) as HTMLButtonElement;
        option.setAttribute("role", "option");
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => {
          this.#selectedModel = `${model.provider}/${model.id}`;
          this.#selector.value = this.#selectedModel;
          const levels = model.thinkingLevels;
          this.#thinking.replaceChildren(
            new Option("Default", ""),
            ...levels.map((level) => new Option(level, level)),
          );
          this.#thinking.disabled = levels.length === 0;
          this.#search.value = model.name;
          this.#modelOpen = false;
          const role = this.#role();
          this.#dirty =
            !!role &&
            this.#selector.value !== (this.#assignmentForScope(role) ?? "");
          this.#renderOptions();
          this.#updateButtons();
        });
        return option;
      }),
    );
  }

  #updateButtons(): void {
    const writable =
      this.#info?.access === "control" &&
      this.#session?.features?.includes(MODEL_ROLES_FEATURE) &&
      !this.#busy &&
      !this.#unsupported;
    const role = this.#role();
    this.#save.disabled =
      !writable || !this.#dirty || !this.#selector.value.trim();
    this.#reset.disabled =
      !writable || this.#busy || !role || !this.#assignmentForScope(role);
    this.#selector.disabled = !writable;
    this.#search.disabled = !writable;
    this.#thinking.disabled = !writable || this.#thinking.options.length <= 1;
    this.#scope.disabled = !writable || this.#scope.options.length <= 1;
    this.#renderOptions();
  }

  async #saveAssignment(reset = false): Promise<void> {
    const session = this.#session;
    const key = this.#key;
    const role = this.#role();
    if (
      !session ||
      !session.features?.includes(MODEL_ROLES_FEATURE) ||
      !key ||
      !role ||
      this.#info?.access !== "control" ||
      this.#busy
    )
      return;
    this.#busy = true;
    this.#actionError = null;
    this.#gate.invalidate();
    this.#update();
    try {
      const info = await postJson<ModelRolesInfo>(
        modelRolesApiUrl(session.host_id, session.instanceId),
        {
          role: role.id,
          selector: reset ? null : this.#selector.value.trim(),
          scope: this.#scope.value as "global" | "project",
        },
      );
      if (this.#key !== key) return;
      this.#info = info;
      this.#dirty = false;
      const updatedRole = this.#role();
      if (updatedRole) this.#seedEditor(updatedRole);
      this.#host.showStatus(
        reset ? "Model role reset" : "Model role saved",
        "ok",
      );
    } catch (error) {
      if (this.#key !== key) return;
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 501) this.#unsupported = true;
      else if (status === 403 && this.#info)
        this.#info = { ...this.#info, access: "view" };
      else this.#actionError = (error as Error).message;
      this.#host.showStatus((error as Error).message, "warning");
    } finally {
      if (this.#key === key) {
        this.#busy = false;
        this.#update();
      }
    }
  }

  #update(): void {
    const session = this.#session;
    this.#empty.hidden = session !== null;
    this.#list.hidden = !session || !this.#info;
    if (!session) {
      this.#note.hidden = true;
      this.#editor.hidden = true;
      return;
    }
    const unsupported =
      this.#unsupported || !session.features?.includes(MODEL_ROLES_FEATURE);
    this.#list.hidden = !this.#info || unsupported;
    const note = unsupported
      ? "Model roles require a newer omp-connected extension."
      : (this.#loadError ??
        this.#actionError ??
        (this.#info?.access === "view"
          ? "View-only access. Model role assignments cannot be changed."
          : this.#info
            ? null
            : "Loading model roles…"));
    this.#note.hidden = !note;
    this.#note.textContent = note ?? "";
    this.#note.classList.toggle(
      "error",
      !!note && !unsupported && this.#info?.access !== "view",
    );
    if (this.#info) {
      this.#renderList();
      const role = this.#role();
      this.#editor.hidden = unsupported || !role;
      const editing =
        this.#dirty ||
        document.activeElement === this.#selector ||
        document.activeElement === this.#search ||
        document.activeElement === this.#thinking ||
        document.activeElement === this.#scope;
      if (role && !editing) {
        const allowedScopes =
          this.#info.storage === "project" ? ["global", "project"] : ["global"];
        const currentScopes = Array.from(
          this.#scope.options,
          (option) => option.value,
        );
        if (JSON.stringify(currentScopes) !== JSON.stringify(allowedScopes)) {
          this.#scope.replaceChildren(
            new Option("Global", "global"),
            ...(this.#info.storage === "project"
              ? [new Option("Project", "project")]
              : []),
          );
        }
        if (!allowedScopes.includes(this.#scope.value))
          this.#scope.value = this.#info.storage;
        this.#seedEditor(role);
      }
      this.#updateButtons();
      const tip = el("p", {
        className: "role-fallback-note",
        text: "OMP resolves automatic and fallback assignments. Save changes the selected scope; Reset removes its assignment so the inherited setting or automatic selection applies.",
      });
      if (!this.#editor.querySelector(".role-fallback-note"))
        this.#editor.prepend(tip);
    }
  }
}
