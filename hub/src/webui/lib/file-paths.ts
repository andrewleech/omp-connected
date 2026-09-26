// Pure path and formatting helpers for the Files inspector tab. Paths are
// POSIX and relative to the session root; "" is the root itself.

import type { FileEntry } from "./session-api";

/** Drops empty and "." segments and surrounding slashes. */
export function normalisePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

export function joinPath(dir: string, name: string): string {
  const base = normalisePath(dir);
  return base ? `${base}/${name}` : name;
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumb trail from the root, which is labelled with the cwd basename
 * (or "/" for a filesystem-root cwd, "root" when the cwd is unknown).
 */
export function breadcrumbs(cwd: string | undefined, path: string): Crumb[] {
  const rootLabel =
    cwd === undefined || cwd === ""
      ? "root"
      : (cwd.split("/").filter(Boolean).pop() ?? "/");
  const trail: Crumb[] = [{ label: rootLabel, path: "" }];
  let current = "";
  for (const segment of normalisePath(path).split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    trail.push({ label: segment, path: current });
  }
  return trail;
}

export function absolutePath(cwd: string, path: string): string {
  const relative = normalisePath(path);
  if (!relative) return cwd;
  return `${cwd.replace(/\/+$/, "")}/${relative}`;
}

export function isPreviewableImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** What a listing row opens: a directory, a downloadable file, or nothing. */
export function entryTarget(entry: FileEntry): "dir" | "file" | null {
  if (entry.type === "dir" || entry.type === "file") return entry.type;
  if (entry.type === "symlink") return entry.target ?? null;
  return null;
}

/** Why `name` cannot be a new folder in the current directory, or null. */
export function folderNameError(name: string): string | null {
  if (name.trim() === "") return "Folder name is empty";
  if (name === "." || name === "..") return `"${name}" is not a folder name`;
  if (name.includes("/")) return "Folder name cannot contain /";
  if (name.includes("\0")) return "Folder name cannot contain NUL";
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
