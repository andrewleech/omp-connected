import { expect, test } from "bun:test";
import { encodeOsc52ForTerminal } from "../../../../../node_modules/@oh-my-pi/pi-coding-agent/src/utils/clipboard.ts";

const ESC = "\x1b";
const DCS_END = "\x1b\\";
const DCS_RESTART = "\x1b\\\x1bP";

test("OSC 52 remains raw outside Screen", () => {
	expect(encodeOsc52ForTerminal("hello", "xterm-256color")).toBe(`${ESC}]52;c;aGVsbG8=\x07`);
});

test("OSC 52 uses Screen DCS pass-through", () => {
	expect(encodeOsc52ForTerminal("hello", "screen-256color-bce")).toBe(`${ESC}P${ESC}]52;c;aGVsbG8=\x07${DCS_END}`);
});

test("Screen OSC 52 splits base64 payloads at 76-byte boundaries", () => {
	const result = encodeOsc52ForTerminal("x".repeat(100), "screen");
	const chunks = result.slice(`${ESC}P${ESC}]52;c;`.length, -DCS_END.length).split(DCS_RESTART);
	expect(chunks).toHaveLength(2);
	expect(chunks[0]).toHaveLength(76);
	expect(Buffer.from(`${chunks.join("").slice(0, -1)}`, "base64").toString()).toBe("x".repeat(100));
});