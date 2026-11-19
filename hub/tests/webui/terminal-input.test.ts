import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { modifiedTerminalInput, onTerminalInput } from "../../src/webui/lib/terminal-input";

test("encodes modified cursor and function keys in xterm format", () => {
  for (const [input, alt, both] of [
    ["\x1b[A", "\x1b[1;3A", "\x1b[1;7A"],
    ["\x1bOD", "\x1b[1;3D", "\x1b[1;7D"],
    ["\x1bOP", "\x1b[1;3P", "\x1b[1;7P"],
    ["\x1b[24~", "\x1b[24;3~", "\x1b[24;7~"],
  ]) {
    expect(modifiedTerminalInput(input!, false, true)).toBe(alt);
    expect(modifiedTerminalInput(input!, true, true)).toBe(both);
  }
  expect(modifiedTerminalInput("\x1b[1;2A", false, true)).toBe("\x1b[1;4A");
  expect(modifiedTerminalInput("\x1b[15~", true, false)).toBe("\x1b[15;5~");
  expect(modifiedTerminalInput("a", true, true)).toBe("\x1b\x01");
  expect(modifiedTerminalInput("\x1b[A", false, false)).toBe("\x1b[A");
});

test("encodes Home and End modifiers in xterm format", () => {
  for (const [input, control, alt, both] of [
    ["\x1b[H", "\x1b[1;5H", "\x1b[1;3H", "\x1b[1;7H"],
    ["\x1bOH", "\x1b[1;5H", "\x1b[1;3H", "\x1b[1;7H"],
    ["\x1b[F", "\x1b[1;5F", "\x1b[1;3F", "\x1b[1;7F"],
    ["\x1bOF", "\x1b[1;5F", "\x1b[1;3F", "\x1b[1;7F"],
    ["\x1b[1;2H", "\x1b[1;6H", "\x1b[1;4H", "\x1b[1;8H"],
    ["\x1b[1;2F", "\x1b[1;6F", "\x1b[1;4F", "\x1b[1;8F"],
    ["\x1b[1~", "\x1b[1;5~", "\x1b[1;3~", "\x1b[1;7~"],
    ["\x1b[4~", "\x1b[4;5~", "\x1b[4;3~", "\x1b[4;7~"],
  ]) {
    expect(modifiedTerminalInput(input!, true, false)).toBe(control);
    expect(modifiedTerminalInput(input!, false, true)).toBe(alt);
    expect(modifiedTerminalInput(input!, true, true)).toBe(both);
  }
});

test("protocol responses do not consume armed modifiers", () => {
  let userEvent = () => {};
  let dataEvent = (_data: string) => {};
  const fake = {
    _core: { coreService: { onUserInput: (listener: () => void) => { userEvent = listener; } } },
    onData: (listener: (data: string) => void) => { dataEvent = listener; },
  };
  const output: string[] = [];
  let alt = true;
  onTerminalInput(fake as unknown as Terminal, (data, userInput) => {
    if (userInput) {
      data = modifiedTerminalInput(data, false, alt);
      alt = false;
    }
    output.push(data);
  });
  dataEvent("\x1b[0n");
  expect(alt).toBe(true);
  userEvent();
  dataEvent("\x1b[A");
  expect(output).toEqual(["\x1b[0n", "\x1b[1;3A"]);
  expect(alt).toBe(false);
});

test("SGR mouse reports pass through without consuming armed modifiers", () => {
  let userEvent = () => {};
  let dataEvent = (_data: string) => {};
  const fake = {
    _core: { coreService: { onUserInput: (listener: () => void) => { userEvent = listener; } } },
    onData: (listener: (data: string) => void) => { dataEvent = listener; },
  };
  const output: string[] = [];
  let control = true;
  let alt = true;
  onTerminalInput(fake as unknown as Terminal, (data, userInput) => {
    if (userInput) {
      data = modifiedTerminalInput(data, control, alt);
      control = false;
      alt = false;
    }
    output.push(data);
  });
  for (const report of ["\x1b[<0;12;34M", "\x1b[<0;12;34m", "\x1b[<64;500;600M"]) {
    userEvent();
    dataEvent(report);
    expect(control).toBe(true);
    expect(alt).toBe(true);
  }
  userEvent();
  dataEvent("\x1b[H");
  expect(output).toEqual([
    "\x1b[<0;12;34M", "\x1b[<0;12;34m", "\x1b[<64;500;600M", "\x1b[1;7H",
  ]);
  expect(control).toBe(false);
  expect(alt).toBe(false);
});
