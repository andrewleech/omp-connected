import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@/server/config";

describe("hub public origin", () => {
  test("uses the configured TLS hostname and hub port", () => {
    const config = loadConfig({
      OMP_HUB_HOST_TOKEN: "test-token",
      OMP_HUB_HOSTNAME: "hub.test",
      OMP_HUB_PORT: "4816",
      OMP_HUB_TLS_CERT: "/tmp/cert.pem",
      OMP_HUB_TLS_KEY: "/tmp/key.pem",
    });

    expect(config.publicOrigin).toBe("https://hub.test:4816");
  });

  test("does not publish an origin without a TLS endpoint", () => {
    const config = loadConfig({
      OMP_HUB_HOST_TOKEN: "test-token",
      OMP_HUB_HOSTNAME: "hub.test",
    });

    expect(config.publicOrigin).toBeNull();
  });
});

describe("hub state dir", () => {
  const token = { OMP_HUB_HOST_TOKEN: "test-token" };
  test("uses OMP_HUB_STATE_DIR, else the XDG state home", () => {
    expect(
      loadConfig({
        ...token,
        OMP_HUB_STATE_DIR: "/srv/hub",
        XDG_STATE_HOME: "/x",
      }).stateDir,
    ).toBe("/srv/hub");
    expect(loadConfig({ ...token, XDG_STATE_HOME: "/x" }).stateDir).toBe(
      "/x/omp-hub",
    );
    expect(loadConfig(token).stateDir).toBe(
      join(homedir(), ".local/state/omp-hub"),
    );
  });
});
