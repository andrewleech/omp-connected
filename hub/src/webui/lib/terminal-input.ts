import type { Terminal } from "@xterm/xterm";

export function modifiedTerminalInput(data: string, control: boolean, alt: boolean): string {
  if (!control && !alt) return data;
  const cursor = /^\x1b(?:\[|O)(?:1;([2-8]))?([ABCDFHPQRS])$/.exec(data);
  const tilde = /^\x1b\[(\d+)(?:;([2-8]))?~$/.exec(data);
  const bits = (control ? 4 : 0) | (alt ? 2 : 0);
  if (cursor) {
    const modifier = ((cursor[1] ? Number(cursor[1]) - 1 : 0) | bits) + 1;
    return `\x1b[1;${modifier}${cursor[2]}`;
  }
  if (tilde) {
    const modifier = ((tilde[2] ? Number(tilde[2]) - 1 : 0) | bits) + 1;
    return `\x1b[${tilde[1]};${modifier}~`;
  }
  if (control && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) data = String.fromCharCode(code & 0x1f);
  }
  return alt ? `\x1b${data}` : data;
}

// xterm reports SGR mouse events as user input, but they are not keystrokes.
// Its core emits onUserInput immediately before onData for genuine input.
export function onTerminalInput(terminal: Terminal, handler: (data: string, userInput: boolean) => void): void {
  const internal = terminal as unknown as { _core: { coreService: { onUserInput(listener: () => void): void } } };
  const core = internal._core;
  let userInput = false;
  core.coreService.onUserInput(() => { userInput = true; });
  terminal.onData((data) => {
    const input = userInput && !/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
    userInput = false;
    handler(data, input);
  });
}
