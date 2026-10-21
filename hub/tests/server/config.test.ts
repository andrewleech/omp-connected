import { describe, expect, test } from "bun:test";
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
