import { expect, test } from "bun:test";
import {
	CHECK_INTERVAL_MS,
	MAX_SCHEDULE_DELAY_MS,
	MAX_SCHEDULED_PROMPTS,
	PromptScheduler,
	ScheduleError,
	type ScheduledPrompt,
} from "../../src/scheduled-prompts.js";

/** A scheduler on a hand-driven clock with one pending timer at a time. */
function harness(send?: (text: string, afterPrevious: boolean) => void | Promise<void>) {
	const clock = { now: 1_000_000 };
	let timer: { fn: () => void; ms: number; dueAt: number } | undefined;
	const sent: { text: string; afterPrevious: boolean }[] = [];
	const errors: { prompt: ScheduledPrompt; error: unknown }[] = [];
	const scheduler = new PromptScheduler({
		send:
			send ??
			((text, afterPrevious) => {
				sent.push({ text, afterPrevious });
			}),
		onError: (prompt, error) => errors.push({ prompt, error }),
		now: () => clock.now,
		setTimer: (fn, ms) => {
			timer = { fn, ms, dueAt: clock.now + ms };
			return timer;
		},
		clearTimer: (handle) => {
			if (handle === timer) timer = undefined;
		},
	});
	return {
		scheduler,
		sent,
		errors,
		clock,
		timerMs: () => timer?.ms,
		/** Moves the clock forward, running every timer whose wait has passed. */
		advance(ms: number) {
			clock.now += ms;
			while (timer && clock.now >= timer.dueAt) {
				const due = timer;
				timer = undefined;
				due.fn();
			}
		},
	};
}

test("a prompt is sent once its delay has passed, and not before", () => {
	const h = harness();
	h.scheduler.add("later", 30_000);
	h.advance(29_999);
	expect(h.sent).toEqual([]);
	h.advance(1);
	expect(h.sent).toEqual([{ text: "later", afterPrevious: false }]);
	expect(h.scheduler.list()).toEqual([]);
});

test("a long wait re-reads the wall clock, so a host that slept sends on waking", () => {
	const h = harness();
	h.scheduler.add("after lunch", 2 * 60 * 60 * 1000);
	expect(h.timerMs()).toBe(CHECK_INTERVAL_MS);
	// The host sleeps for three hours; the timer fires once when it wakes.
	h.clock.now += 3 * 60 * 60 * 1000;
	h.advance(CHECK_INTERVAL_MS);
	expect(h.sent.map((s) => s.text)).toEqual(["after lunch"]);
});

test("prompts falling due together go out in time order, later ones queued behind the first", () => {
	const h = harness();
	h.scheduler.add("second", 20_000);
	h.scheduler.add("first", 10_000);
	h.scheduler.add("third", 20_000);
	expect(h.scheduler.list().map((p) => p.text)).toEqual(["first", "second", "third"]);
	h.clock.now += 25_000;
	h.advance(0);
	expect(h.sent).toEqual([
		{ text: "first", afterPrevious: false },
		{ text: "second", afterPrevious: true },
		{ text: "third", afterPrevious: true },
	]);
});

test("a prompt due moments after another is queued behind it, not sent as its own turn", () => {
	const h = harness();
	h.scheduler.add("first", 10_000);
	h.scheduler.add("close behind", 10_400);
	h.scheduler.add("well after", 12_000);
	h.advance(10_000);
	expect(h.sent).toEqual([
		{ text: "first", afterPrevious: false },
		{ text: "close behind", afterPrevious: true },
	]);
	h.advance(2_000);
	expect(h.sent.at(-1)).toEqual({ text: "well after", afterPrevious: false });
});

test("a cancelled prompt is never sent, and the next one still is", () => {
	const h = harness();
	const dropped = h.scheduler.add("dropped", 5_000);
	h.scheduler.add("kept", 8_000);
	expect(h.scheduler.cancel(dropped.id)).toBe(true);
	expect(h.scheduler.cancel(dropped.id)).toBe(false);
	h.advance(5_000);
	h.advance(3_000);
	expect(h.sent.map((s) => s.text)).toEqual(["kept"]);
});

test("clear drops every waiting prompt and reports how many", () => {
	const h = harness();
	h.scheduler.add("a", 1_000);
	h.scheduler.add("b", 2_000);
	expect(h.scheduler.clear()).toBe(2);
	expect(h.timerMs()).toBeUndefined();
	h.advance(10_000);
	expect(h.sent).toEqual([]);
});

test("invalid requests are refused without queueing anything", () => {
	const h = harness();
	for (const [text, delay] of [
		["   ", 1_000],
		["x", -1],
		["x", 1.5],
		["x", MAX_SCHEDULE_DELAY_MS + 1],
		["x", Number.NaN],
	] as const) {
		expect(() => h.scheduler.add(text, delay)).toThrow(ScheduleError);
	}
	expect(h.scheduler.list()).toEqual([]);
	expect(h.scheduler.add("edge", MAX_SCHEDULE_DELAY_MS).fireAt).toBe(h.clock.now + MAX_SCHEDULE_DELAY_MS);
});

test("the waiting list is bounded", () => {
	const h = harness();
	for (let i = 0; i < MAX_SCHEDULED_PROMPTS; i += 1) h.scheduler.add(`p${i}`, 60_000);
	expect(() => h.scheduler.add("one more", 60_000)).toThrow(ScheduleError);
});

test("a failed send is reported and leaves the prompt off the list", async () => {
	const failure = new Error("not ready");
	const h = harness(() => Promise.reject(failure));
	const prompt = h.scheduler.add("doomed", 1_000);
	h.advance(1_000);
	await Promise.resolve();
	await Promise.resolve();
	expect(h.errors).toEqual([{ prompt, error: failure }]);
	expect(h.scheduler.list()).toEqual([]);
});
