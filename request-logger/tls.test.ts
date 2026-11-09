import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpstreamAgent } from "./tls";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createUpstreamAgent", () => {
  it("adds system trust without replacing bundled or extra CA certificates", () => {
    const getCertificates = vi
      .spyOn(tls, "getCACertificates")
      .mockImplementation((type) =>
        type === "system"
          ? ["corporate-ca", "bundled-ca"]
          : ["bundled-ca", "extra-ca"]
      );

    const agent = createUpstreamAgent();
    expect(getCertificates.mock.calls).toEqual([["default"], ["system"]]);
    expect(agent.options.ca).toEqual([
      "bundled-ca",
      "extra-ca",
      "corporate-ca",
    ]);
    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(agent.options.keepAlive).toBe(true);
    agent.destroy();
  });

  it("preserves default trust when the system store is empty", () => {
    vi.spyOn(tls, "getCACertificates").mockImplementation((type) =>
      type === "system" ? [] : ["bundled-ca", "extra-ca"]
    );

    const agent = createUpstreamAgent();
    expect(agent.options.ca).toEqual(["bundled-ca", "extra-ca"]);
    expect(agent.options.rejectUnauthorized).toBe(true);
    agent.destroy();
  });

  it("warns on older Node versions while keeping certificate verification enabled", () => {
    vi.spyOn(tls, "getCACertificates");
    Object.defineProperty(tls, "getCACertificates", { value: undefined });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = createUpstreamAgent();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("NODE_EXTRA_CA_CERTS")
    );
    expect(agent.options.ca).toBeUndefined();
    expect(agent.options.rejectUnauthorized).toBe(true);
    agent.destroy();
  });

  it("does not swallow failures reading the certificate store", () => {
    vi.spyOn(tls, "getCACertificates").mockImplementation(() => {
      throw new Error("certificate store unavailable");
    });

    expect(createUpstreamAgent).toThrow("certificate store unavailable");
  });
});
