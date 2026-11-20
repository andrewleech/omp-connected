import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HELPER_PATH,
	DEFAULT_PROTECTED_PATHS,
	defaultTransferConfigPath,
	expandHome,
	getDestination,
	loadTransferConfig,
	parseTransferConfig,
	resolveDestinationPolicy,
	TransferConfigError,
} from "../../../src/transfer/config.js";

const HOME = "/home/user";
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "transfer-config-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function destination(overrides: Record<string, unknown> = {}) {
	return { hostId: "user@worker-host", ssh: { target: "user@worker-host" }, ...overrides };
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return (error as TransferConfigError).code;
	}
	return undefined;
}

async function load(value: unknown, options: { home?: string } = {}) {
	const file = join(root, "transfer.json");
	await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
	return loadTransferConfig(file, { home: HOME, ...options });
}

async function rejects(value: unknown) {
	const error = await load(value).then(
		() => undefined,
		(caught) => caught,
	);
	expect(error).toBeInstanceOf(TransferConfigError);
	expect(error.code).toBe("invalid");
	return error as TransferConfigError;
}

describe("loadTransferConfig defaults", () => {
	test("a missing file yields a disabled config with no destinations", async () => {
		expect(await loadTransferConfig(join(root, "absent.json"), { home: HOME })).toEqual({
			enabled: false,
			destinations: {},
		});
	});

	test("an empty object is disabled", async () => {
		expect(await load({})).toEqual({ enabled: false, destinations: {} });
	});

	test("destinations without enabled stay disabled", async () => {
		const config = await load({ destinations: { box: destination() } });
		expect(config.enabled).toBe(false);
		expect(codeOf(() => getDestination(config, "box"))).toBe("disabled");
	});

	test("the default path honours an absolute XDG_CONFIG_HOME and falls back to ~/.config", () => {
		expect(defaultTransferConfigPath({ XDG_CONFIG_HOME: "/xdg/config" }, HOME)).toBe(
			"/xdg/config/omp-connected/transfer.json",
		);
		expect(defaultTransferConfigPath({}, HOME)).toBe("/home/user/.config/omp-connected/transfer.json");
		expect(defaultTransferConfigPath({ XDG_CONFIG_HOME: "relative" }, HOME)).toBe(
			"/home/user/.config/omp-connected/transfer.json",
		);
	});

	test("loads from the default path when none is given", async () => {
		const dir = join(root, "xdg", "omp-connected");
		await Bun.write(join(dir, "transfer.json"), JSON.stringify({ enabled: true, destinations: { box: destination() } }));
		const config = await loadTransferConfig(undefined, { home: HOME, env: { XDG_CONFIG_HOME: join(root, "xdg") } });
		expect(config.enabled).toBe(true);
		expect(Object.keys(config.destinations)).toEqual(["box"]);
	});

	test("destination defaults apply", async () => {
		const config = await load({ enabled: true, destinations: { box: destination() } });
		expect(config.destinations.box).toEqual({
			hostId: "user@worker-host",
			ssh: { target: "user@worker-host" },
			helperPath: DEFAULT_HELPER_PATH,
			allowedRoots: ["~"],
			protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		});
	});
});

describe("loadTransferConfig valid input", () => {
	test("full example from the contract", async () => {
		const config = await load({
			enabled: true,
			destinations: {
				"worker.1": destination({
					ssh: { target: "user@worker-host", port: 2222, identityFile: "~/.ssh/id" },
					helperPath: ".local/bin/ompc-transfer-helper",
					allowedRoots: ["~", "/srv/projects/"],
					protectedPaths: ["~/.ssh", "~/extra"],
				}),
			},
		});
		const worker = config.destinations["worker.1"];
		expect(worker.ssh).toEqual({ target: "user@worker-host", port: 2222, identityFile: "/home/user/.ssh/id" });
		expect(worker.allowedRoots).toEqual(["~", "/srv/projects"]);
		expect(worker.protectedPaths).toEqual(["~/.ssh", "~/extra", "~/.omp", "~/.config", "~/.local/state"]);
	});

	test("identityFile expands against the injected home, not the process home", async () => {
		const config = await load(
			{ enabled: true, destinations: { box: destination({ ssh: { target: "worker-host", identityFile: "~/k" } }) } },
			{ home: "/elsewhere/me" },
		);
		expect(config.destinations.box.ssh.identityFile).toBe("/elsewhere/me/k");
	});

	test("destination-side paths are left unexpanded", async () => {
		const config = await load({ enabled: true, destinations: { box: destination({ allowedRoots: ["~/work"] }) } });
		expect(config.destinations.box.allowedRoots).toEqual(["~/work"]);
	});

	test("accepts hostnames, ssh aliases, IPv4 and bracketed IPv6 targets", () => {
		for (const target of ["worker-host", "user@worker-host", "u.s_er@host.example.org", "10.0.0.5", "user@[fe80::1]"]) {
			const config = parseTransferConfig({ enabled: true, destinations: { box: destination({ ssh: { target } }) } }, HOME);
			expect(config.destinations.box.ssh.target).toBe(target);
		}
	});

	test("accepts destination names at the length boundary", () => {
		const name = `a${"b".repeat(63)}`;
		const config = parseTransferConfig({ enabled: true, destinations: { [name]: destination() } }, HOME);
		expect(Object.keys(config.destinations)).toEqual([name]);
	});
});

describe("loadTransferConfig rejections", () => {
	test("invalid JSON", async () => {
		expect((await rejects("{ nope")).message).toContain("not valid JSON");
	});

	test("non-object root and unknown top-level keys", async () => {
		await rejects([]);
		await rejects("null");
		expect((await rejects({ enabled: true, extra: 1 })).message).toContain("config.extra");
	});

	test("enabled must be a boolean", async () => {
		await rejects({ enabled: "yes" });
		await rejects({ enabled: 1 });
	});

	test("destinations must be an object", async () => {
		await rejects({ destinations: [] });
		await rejects({ destinations: null });
		await rejects({ destinations: "box" });
	});

	test.each(["-box", ".box", "_box", "a b", "a/b", "", "a".repeat(65), "__proto__", "bo\u00e9x"])(
		"destination name %j is rejected",
		async (name) => {
			await rejects(`{"enabled":true,"destinations":{${JSON.stringify(name)}:${JSON.stringify(destination())}}}`);
		},
	);

	test("hostId and ssh are required and typed", async () => {
		await rejects({ destinations: { box: { ssh: { target: "worker-host" } } } });
		await rejects({ destinations: { box: { hostId: "x" } } });
		await rejects({ destinations: { box: destination({ hostId: "" }) } });
		await rejects({ destinations: { box: destination({ hostId: 5 }) } });
		await rejects({ destinations: { box: destination({ hostId: "a\nb" }) } });
		await rejects({ destinations: { box: destination({ ssh: "worker-host" }) } });
		await rejects({ destinations: { box: "worker-host" } });
	});

	test("unknown destination fields are rejected", async () => {
		await rejects({ destinations: { box: destination({ env: {} }) } });
	});

	test.each([
		"ProxyCommand",
		"proxyCommand",
		"ProxyJump",
		"Options",
		"options",
		"args",
		"extraArgs",
		"LocalCommand",
		"PermitLocalCommand",
		"StrictHostKeyChecking",
		"User",
		"Hostname",
		"ForwardAgent",
	])("ssh field %s that could smuggle an option is rejected", async (field) => {
		const error = await rejects({
			destinations: { box: destination({ ssh: { target: "worker-host", [field]: "x" } }) },
		});
		expect(error.message).toContain(field);
	});

	test.each([
		"-oProxyCommand=touch /tmp/x",
		"-F/etc/passwd",
		"-worker",
		"user@-host",
		"user@host extra",
		"user@host;id",
		"host`id`",
		"$(id)@host",
		"user@host&",
		"user@@host",
		"@host",
		"user@",
		"ssh://user@host",
		"user@[::1",
		"host\nProxyCommand=x",
		"",
	])("ssh target %j is rejected", async (target) => {
		await rejects({ destinations: { box: destination({ ssh: { target } }) } });
	});

	test("ssh target must be a string", async () => {
		await rejects({ destinations: { box: destination({ ssh: { target: ["worker-host"] } }) } });
		await rejects({ destinations: { box: destination({ ssh: {} }) } });
	});

	test.each([0, -1, 65536, 1.5, "22", null, true])("ssh port %j is rejected", async (port) => {
		await rejects({ destinations: { box: destination({ ssh: { target: "worker-host", port } }) } });
	});

	test.each(["-oIdentityAgent=x", "-i", "relative/key", "~other/key", "", "~/a\0b"])(
		"identityFile %j is rejected",
		async (identityFile) => {
			await rejects({ destinations: { box: destination({ ssh: { target: "worker-host", identityFile } }) } });
		},
	);

	test.each(["bin/helper;id", "-helper", "../helper", "bin/../helper", "bin/", "bin helper", "$HOME/helper", "~/helper", "", 5])(
		"helperPath %j is rejected",
		async (helperPath) => {
			await rejects({ destinations: { box: destination({ helperPath }) } });
		},
	);

	test("helperPath may be absolute", () => {
		const config = parseTransferConfig({ enabled: true, destinations: { box: destination({ helperPath: "/opt/omp/helper" }) } }, HOME);
		expect(config.destinations.box.helperPath).toBe("/opt/omp/helper");
	});

	test.each([
		[[]],
		[["/"]],
		[["//"]],
		[["relative"]],
		[["~other"]],
		[["~/../etc"]],
		[["/srv/../etc"]],
		[[""]],
		[[5]],
		["~"],
	])("allowedRoots %j is rejected", async (allowedRoots) => {
		await rejects({ destinations: { box: destination({ allowedRoots }) } });
	});

	test("protectedPaths must be an array of destination paths", async () => {
		await rejects({ destinations: { box: destination({ protectedPaths: "~/.ssh" }) } });
		await rejects({ destinations: { box: destination({ protectedPaths: ["relative"] }) } });
		await rejects({ destinations: { box: destination({ protectedPaths: ["~/../x"] }) } });
	});

	test("a failing destination fails the whole file even when others are valid", async () => {
		await rejects({
			enabled: true,
			destinations: { good: destination(), bad: destination({ ssh: { target: "-x" } }) },
		});
	});
});

describe("getDestination", () => {
	const config = parseTransferConfig({ enabled: true, destinations: { box: destination() } }, HOME);

	test("returns the configured destination", () => {
		expect(getDestination(config, "box")).toBe(config.destinations.box);
	});

	test("unknown, malformed and inherited names are refused", () => {
		for (const name of ["other", "constructor", "toString", "__proto__", "-x", "", "a b"]) {
			expect(codeOf(() => getDestination(config, name))).toBe("unknown-destination");
		}
	});

	test("a disabled config refuses every name", () => {
		expect(codeOf(() => getDestination({ ...config, enabled: false }, "box"))).toBe("disabled");
	});
});

describe("expandHome and resolveDestinationPolicy", () => {
	test("expandHome", () => {
		expect(expandHome("~", HOME)).toBe("/home/user");
		expect(expandHome("~/a/b", HOME)).toBe("/home/user/a/b");
		expect(expandHome("~/a", "/home/user/")).toBe("/home/user/a");
		expect(expandHome("/abs/~", HOME)).toBe("/abs/~");
		expect(expandHome("~other/a", HOME)).toBe("~other/a");
		expect(expandHome("rel/a", HOME)).toBe("rel/a");
	});

	test("policy resolves against the destination home", async () => {
		const config = await load({ enabled: true, destinations: { box: destination({ allowedRoots: ["~", "/srv"] }) } });
		const policy = resolveDestinationPolicy(config.destinations.box, "/home/worker");
		expect(policy.home).toBe("/home/worker");
		expect(policy.allowedRoots).toEqual(["/home/worker", "/srv"]);
		expect(policy.protectedPaths).toEqual([
			"/home/worker/.ssh",
			"/home/worker/.omp",
			"/home/worker/.config",
			"/home/worker/.local/state",
		]);
	});
});
