// Small DOM helpers shared by the dashboard shell and its inspector panes.

export function el(
  name: string,
  options: {
    className?: string;
    text?: string;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    title?: string;
  } = {},
): HTMLElement {
  const node = document.createElement(name);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) (node as HTMLButtonElement).type = options.type;
  if (options.disabled !== undefined)
    (node as HTMLButtonElement).disabled = options.disabled;
  if (options.title) node.title = options.title;
  return node;
}

export function button(text: string, className = ""): HTMLButtonElement {
  return el("button", { type: "button", text, className }) as HTMLButtonElement;
}

/**
 * Copies `text` to the clipboard. The async Clipboard API needs a secure
 * context, which a hub reached over plain HTTP on a tailnet is not, so this
 * falls back to a selected off-screen textarea and `execCommand("copy")`.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the selection-based copy
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus();
  return copied;
}
