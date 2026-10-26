// Dashboard session groups (the custom "projects" in the session rail).
// The hub keeps them in one JSON file under its state dir, so every
// dashboard tab and device shows the same groups; each change is pushed to
// /ws/dashboard as a `groups.changed` event carrying the full list.
//
// Members are stable session keys built by the dashboard
// (`groupMemberKey` in webui/lib/workspace.ts): `${hostId}:label:${label}`
// or `${hostId}:instance:${instanceId}`. The hub treats them as opaque
// strings and only checks their shape.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Context, Elysia } from "elysia";
import { RateLimiter } from "./rate-limit";
import type { SessionGroup, SessionGroupList } from "./types";

const FILE_NAME = "session-groups.json";
const FILE_VERSION = 1;
export const MAX_GROUP_NAME = 64;
export const MAX_GROUPS = 100;
/** Members across all groups together. */
export const MAX_GROUP_MEMBERS = 1000;
const MAX_MEMBER_KEY = 300;
const MEMBER_KEY_PATTERN = /^\S+:(?:label|instance):\S+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A request the store refuses; `status` is the HTTP answer. */
export class GroupRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isGroupMemberKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MEMBER_KEY &&
    MEMBER_KEY_PATTERN.test(value) &&
    !CONTROL_CHARS.test(value)
  );
}

/** The trimmed group name, or an error for an empty, long or control-character name. */
export function parseGroupName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_GROUP_NAME || CONTROL_CHARS.test(name))
    throw new GroupRequestError(
      `Group name must be 1-${MAX_GROUP_NAME} characters.`,
      400,
    );
  return name;
}

function parseMemberKey(value: unknown): string {
  if (!isGroupMemberKey(value))
    throw new GroupRequestError("Invalid session key.", 400);
  return value;
}

function checkLimits(groups: SessionGroup[]): void {
  if (groups.length > MAX_GROUPS)
    throw new GroupRequestError(`At most ${MAX_GROUPS} groups.`, 400);
  if (
    groups.reduce((total, group) => total + group.sessions.length, 0) >
    MAX_GROUP_MEMBERS
  )
    throw new GroupRequestError(
      `At most ${MAX_GROUP_MEMBERS} grouped sessions.`,
      400,
    );
}

/** The state file's content, or null when it is not valid. */
function parseStateFile(value: unknown): SessionGroupList | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== FILE_VERSION ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !("groups" in value) ||
    !Array.isArray(value.groups)
  )
    return null;
  const groups: SessionGroup[] = [];
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const group of value.groups) {
    if (
      typeof group !== "object" ||
      group === null ||
      !("id" in group) ||
      typeof group.id !== "string" ||
      !group.id ||
      ids.has(group.id) ||
      !("name" in group) ||
      !("sessions" in group) ||
      !Array.isArray(group.sessions)
    )
      return null;
    let name: string;
    try {
      name = parseGroupName(group.name);
    } catch {
      return null;
    }
    const sessions: string[] = [];
    for (const key of group.sessions) {
      if (!isGroupMemberKey(key) || members.has(key)) return null;
      members.add(key);
      sessions.push(key);
    }
    ids.add(group.id);
    groups.push({ id: group.id, name, sessions });
  }
  try {
    checkLimits(groups);
  } catch {
    return null;
  }
  return { revision: value.revision, groups };
}

export class SessionGroupStore {
  readonly path: string;
  private state: SessionGroupList;
  private listeners = new Set<(list: SessionGroupList) => void>();

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE_NAME);
    this.state = this.load();
  }

  /** The groups and their revision, which every change increments. */
  snapshot(): SessionGroupList {
    return structuredClone(this.state);
  }

  private list(): SessionGroup[] {
    return structuredClone(this.state.groups);
  }

  /** Called with the new snapshot after every change. */
  onChange(listener: (list: SessionGroupList) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a group at the end, moving `session` into it when given. */
  create(name: unknown, session?: unknown): SessionGroup {
    const group: SessionGroup = {
      id: crypto.randomUUID(),
      name: parseGroupName(name),
      sessions: [],
    };
    const next = this.list();
    if (session !== undefined) {
      const key = parseMemberKey(session);
      removeMember(next, key);
      group.sessions.push(key);
    }
    next.push(group);
    this.commit(next);
    return structuredClone(group);
  }

  /** Moves `session` into the group `groupId`, or out of every group for null. */
  assign(session: unknown, groupId: unknown): void {
    const key = parseMemberKey(session);
    if (groupId !== null && typeof groupId !== "string")
      throw new GroupRequestError("groupId must be a string or null.", 400);
    const next = this.list();
    const target =
      groupId === null ? null : next.find((group) => group.id === groupId);
    if (target === undefined)
      throw new GroupRequestError(`group '${groupId}' not found`, 404);
    removeMember(next, key);
    target?.sessions.push(key);
    this.commit(next);
  }

  /**
   * Replaces an empty group list with `groups` (a dashboard's former
   * browser-local groups). Refused with 409 once the hub has any group, so
   * two dashboards importing at once cannot both apply.
   */
  importGroups(groups: unknown): void {
    if (!Array.isArray(groups))
      throw new GroupRequestError("groups must be an array.", 400);
    if (this.state.groups.length > 0)
      throw new GroupRequestError("The hub already has groups.", 409);
    const next: SessionGroup[] = groups.map((entry) => {
      const sessions = field(entry, "sessions");
      if (!Array.isArray(sessions))
        throw new GroupRequestError("Each group needs a sessions array.", 400);
      return {
        id: crypto.randomUUID(),
        name: parseGroupName(field(entry, "name")),
        sessions: sessions.map(parseMemberKey),
      };
    });
    const seen = new Set<string>();
    for (const group of next)
      group.sessions = group.sessions.filter((key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    this.commit(next);
  }

  private commit(groups: SessionGroup[]): void {
    checkLimits(groups);
    const next = { revision: this.state.revision + 1, groups };
    this.write(next);
    this.state = next;
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private load(): SessionGroupList {
    const empty = { revision: 0, groups: [] };
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    let state: SessionGroupList | null = null;
    try {
      state = parseStateFile(JSON.parse(raw));
    } catch {
      // Not JSON; handled below with every other invalid file.
    }
    if (state) return state;
    const aside = `${this.path}.corrupt-${Date.now()}`;
    try {
      renameSync(this.path, aside);
      console.error(
        `session groups: ${this.path} is not valid; moved it to ${aside} and started with no groups`,
      );
    } catch (error) {
      console.error(
        `session groups: ${this.path} is not valid and could not be moved aside (${(error as Error).message}); started with no groups`,
      );
    }
    return empty;
  }

  /** Atomic replace: a crash leaves either the old or the new file. */
  private write(state: SessionGroupList): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(
          fd,
          `${JSON.stringify({ version: FILE_VERSION, ...state })}\n`,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

function removeMember(groups: SessionGroup[], key: string): void {
  for (const group of groups)
    group.sessions = group.sessions.filter((entry) => entry !== key);
}

/** One property of a JSON object body, or undefined for anything else. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * REST routes, one per dashboard action, so concurrent edits from several
 * dashboards each apply to the current list instead of replacing it.
 */
export function sessionGroupRoutes(store: SessionGroupStore) {
  // Writes are global (the dashboard has no per-user identity), so they
  // share one limit.
  const limiter = new RateLimiter({ max: 30, windowMs: 10_000 });

  function change<T>(set: Context["set"], apply: () => T) {
    if (!limiter.allow("groups")) {
      set.status = 429;
      set.headers["retry-after"] = "1";
      return { error: "Rate limit: group changes (30 per 10s)" };
    }
    try {
      return apply();
    } catch (error) {
      if (!(error instanceof GroupRequestError)) {
        console.error(
          `session groups: could not save ${store.path}: ${(error as Error).message}`,
        );
        set.status = 500;
        return { error: "Could not save groups on the hub." };
      }
      set.status = error.status;
      return { error: error.message };
    }
  }

  return new Elysia({ prefix: "/api/groups" })
    .get("/", () => store.snapshot())
    .post("/", ({ body, set }) =>
      change(set, () => {
        const group = store.create(field(body, "name"), field(body, "session"));
        return { group, ...store.snapshot() };
      }),
    )
    .post("/assign", ({ body, set }) =>
      change(set, () => {
        store.assign(field(body, "session"), field(body, "groupId"));
        return store.snapshot();
      }),
    )
    .post("/import", ({ body, set }) =>
      change(set, () => {
        store.importGroups(field(body, "groups"));
        return store.snapshot();
      }),
    );
}
