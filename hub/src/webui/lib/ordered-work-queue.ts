/**
 * Runs expensive work with bounded concurrency while committing outcomes in
 * input order. A rejected item still retires its sequence slot, so a timed-out
 * operation cannot permanently block later work.
 */
export class OrderedWorkQueue<Input, Output> {
  #queued: Array<{ sequence: number; input: Input }> = [];
  #settled = new Map<number, PromiseSettledResult<Output>>();
  #running = 0;
  #nextSequence = 0;
  #nextCommit = 0;
  #closed = false;
  readonly #concurrency: number;
  readonly #work: (input: Input) => Promise<Output>;
  readonly #commit: (result: PromiseSettledResult<Output>) => void;

  constructor(
    concurrency: number,
    work: (input: Input) => Promise<Output>,
    commit: (result: PromiseSettledResult<Output>) => void,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("concurrency must be a positive integer");
    this.#concurrency = concurrency;
    this.#work = work;
    this.#commit = commit;
  }

  get idle(): boolean {
    return (
      this.#queued.length === 0 &&
      this.#running === 0 &&
      this.#settled.size === 0
    );
  }

  enqueue(input: Input): void {
    if (this.#closed) return;
    this.#queued.push({ sequence: this.#nextSequence++, input });
    this.#pump();
  }

  close(): void {
    this.#closed = true;
    this.#queued = [];
    this.#settled.clear();
  }

  #pump(): void {
    while (!this.#closed && this.#running < this.#concurrency) {
      const item = this.#queued.shift();
      if (!item) return;
      this.#running++;
      void this.#run(item);
    }
  }

  async #run(item: { sequence: number; input: Input }): Promise<void> {
    let result: PromiseSettledResult<Output>;
    try {
      result = { status: "fulfilled", value: await this.#work(item.input) };
    } catch (reason) {
      result = { status: "rejected", reason };
    }

    this.#running--;
    if (!this.#closed) {
      this.#settled.set(item.sequence, result);
      this.#commitReady();
      this.#pump();
    }
  }

  #commitReady(): void {
    while (true) {
      const result = this.#settled.get(this.#nextCommit);
      if (!result) return;
      this.#settled.delete(this.#nextCommit++);
      this.#commit(result);
    }
  }
}
