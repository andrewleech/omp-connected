// Prompts queued from the dashboard to be sent to this session later.
//
// The owner session holds them in memory and sends each one through its own
// prompt path when it falls due, so a queued prompt survives the browser
// closing and the hub restarting, and ends with the omp process. A single
// timer covers the soonest item; it never waits longer than CHECK_INTERVAL_MS
// before comparing against the wall clock again, so a host that sleeps
// through a due time sends as soon as it wakes rather than a sleep-length late.

/** Longest accepted delay. */
export const MAX_SCHEDULE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest accepted prompt text, in UTF-16 code units. */
export const MAX_SCHEDULED_TEXT = 100_000;
/** Most prompts waiting at once. */
export const MAX_SCHEDULED_PROMPTS = 20;
/** Longest the timer sleeps before it re-reads the wall clock. */
export const CHECK_INTERVAL_MS = 60_000;
/** Prompts falling due within this long of the first due one go out with
 *  it, queued behind it, rather than racing it as a separate turn. */
export const DUE_TOGETHER_MS = 1_000;

export interface ScheduledPrompt {
	id: string;
	text: string;
	/** Epoch ms, by this host's clock. */
	fireAt: number;
	createdAt: number;
}

export interface PromptSchedulerOptions {
	/** Sends one due prompt. `afterPrevious` is set for every prompt after the
	 *  first in a batch (see DUE_TOGETHER_MS), which must queue behind it. */
	send: (text: string, afterPrevious: boolean) => void | Promise<void>;
	/** Reports a send that threw or rejected. */
	onError: (prompt: ScheduledPrompt, error: unknown) => void;
	/** Called after every change to the waiting list, with the new list. */
	onChange?: (prompts: readonly ScheduledPrompt[]) => void;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class ScheduleError extends Error {}

export class PromptScheduler {
	readonly #options: PromptSchedulerOptions;
	readonly #now: () => number;
	readonly #setTimer: (fn: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	/** Kept sorted by fireAt, then by insertion. */
	#prompts: ScheduledPrompt[] = [];
	#timer: unknown;

	constructor(options: PromptSchedulerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	list(): ScheduledPrompt[] {
		return this.#prompts.map((prompt) => ({ ...prompt }));
	}

	/** Queues `text` to be sent `delayMs` from now; throws ScheduleError on invalid input. */
	add(text: string, delayMs: number): ScheduledPrompt {
		if (text.trim() === "") throw new ScheduleError("text must not be empty");
		if (text.length > MAX_SCHEDULED_TEXT) {
			throw new ScheduleError(`text must be at most ${MAX_SCHEDULED_TEXT} characters`);
		}
		if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_SCHEDULE_DELAY_MS) {
			throw new ScheduleError(`delayMs must be a whole number from 0 to ${MAX_SCHEDULE_DELAY_MS}`);
		}
		if (this.#prompts.length >= MAX_SCHEDULED_PROMPTS) {
			throw new ScheduleError(`at most ${MAX_SCHEDULED_PROMPTS} prompts can wait at once`);
		}
		const now = this.#now();
		const prompt: ScheduledPrompt = { id: crypto.randomUUID(), text, fireAt: now + delayMs, createdAt: now };
		const at = this.#prompts.findIndex((other) => other.fireAt > prompt.fireAt);
		this.#prompts.splice(at === -1 ? this.#prompts.length : at, 0, prompt);
		this.#changed();
		return { ...prompt };
	}

	/** Removes a waiting prompt; false when there is no such prompt. */
	cancel(id: string): boolean {
		const at = this.#prompts.findIndex((prompt) => prompt.id === id);
		if (at === -1) return false;
		this.#prompts.splice(at, 1);
		this.#changed();
		return true;
	}

	/** Drops every waiting prompt without sending it; returns how many there were. */
	clear(): number {
		const dropped = this.#prompts.length;
		this.#prompts = [];
		this.#changed();
		return dropped;
	}

	#changed(): void {
		this.#arm();
		this.#options.onChange?.(this.list());
	}

	#arm(): void {
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		const next = this.#prompts[0];
		if (!next) return;
		const wait = Math.min(Math.max(0, next.fireAt - this.#now()), CHECK_INTERVAL_MS);
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			this.#fireDue();
		}, wait);
	}

	#fireDue(): void {
		const now = this.#now();
		const first = this.#prompts[0];
		if (!first || first.fireAt > now) {
			this.#arm();
			return;
		}
		const until = first.fireAt + DUE_TOGETHER_MS;
		const due: ScheduledPrompt[] = [];
		while (this.#prompts[0] && this.#prompts[0].fireAt <= Math.max(now, until)) {
			due.push(this.#prompts.shift() as ScheduledPrompt);
		}
		this.#changed();
		due.forEach((prompt, index) => {
			try {
				void Promise.resolve(this.#options.send(prompt.text, index > 0)).catch((error: unknown) =>
					this.#options.onError(prompt, error),
				);
			} catch (error) {
				this.#options.onError(prompt, error);
			}
		});
	}
}
