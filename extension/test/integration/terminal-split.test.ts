import { expect, test } from "bun:test";
import { splitTmuxPane } from "../../src/terminal.js";

test("does not split after the transport closes during either lookup", async () => {
	for (const blocked of ["list-clients", "display-message"]) {
		const gate = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const commands: string[][] = [];
		let active = true;
		const run = (args: string[]): Promise<string> => {
			commands.push(args);
			if (args[0] === blocked) {
				started.resolve();
				return gate.promise;
			}
			return Promise.resolve(args[0] === "list-clients" ? "123 /dev/pts/4" : "%7");
		};
		const split = splitTmuxPane(123, true, run, () => active);
		await started.promise;
		active = false;
		gate.resolve(blocked === "list-clients" ? "123 /dev/pts/4" : "%7");
		await split;
		expect(commands.some((args) => args[0] === "split-window")).toBe(false);
		if (blocked === "list-clients") expect(commands).toHaveLength(1);
	}
});

