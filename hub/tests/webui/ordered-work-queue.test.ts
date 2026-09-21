import { expect, test } from "bun:test";
import { OrderedWorkQueue } from "../../src/webui/lib/ordered-work-queue";

test("bounds concurrent work and commits reverse completions in input order", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const third = Promise.withResolvers<string>();
  const gates = [first, second, third];
  const thirdStarted = Promise.withResolvers<void>();
  const firstTwoCommitted = Promise.withResolvers<void>();
  const allCommitted = Promise.withResolvers<void>();
  const started: number[] = [];
  const committed: string[] = [];
  const queue = new OrderedWorkQueue(
    2,
    (value: number) => {
      started.push(value);
      if (value === 2) thirdStarted.resolve();
      return gates[value].promise;
    },
    (result) => {
      if (result.status !== "fulfilled") return;
      committed.push(result.value);
      if (committed.length === 2) firstTwoCommitted.resolve();
      if (committed.length === 3) allCommitted.resolve();
    },
  );

  queue.enqueue(0);
  queue.enqueue(1);
  queue.enqueue(2);
  expect(started).toEqual([0, 1]);

  second.resolve("second");
  await thirdStarted.promise;
  expect(committed).toEqual([]);
  expect(started).toEqual([0, 1, 2]);

  first.resolve("first");
  await firstTwoCommitted.promise;
  expect(committed).toEqual(["first", "second"]);

  third.resolve("third");
  await allCommitted.promise;
  expect(committed).toEqual(["first", "second", "third"]);
  expect(queue.idle).toBe(true);
});

test("retires a failed item so a later frame is not blocked", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const committed = Promise.withResolvers<void>();
  const results: PromiseSettledResult<string>[] = [];
  const queue = new OrderedWorkQueue(
    2,
    (value: number) => (value === 0 ? first.promise : second.promise),
    (result) => {
      results.push(result);
      if (results.length === 2) committed.resolve();
    },
  );

  queue.enqueue(0);
  queue.enqueue(1);
  second.resolve("later");
  first.reject(new Error("decrypt timeout"));
  await committed.promise;
  expect(results.map((result) => result.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(queue.idle).toBe(true);
});
