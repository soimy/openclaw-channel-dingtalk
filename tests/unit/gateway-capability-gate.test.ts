import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  checkDocsGatewayCapability,
  checkProactiveSendGatewayCapability,
  resolveGatewayCapabilityConfig,
} from "../../src/config";

function makeCfg(dingtalk: Record<string, unknown>): OpenClawConfig {
  return { channels: { dingtalk } } as unknown as OpenClawConfig;
}

describe("resolveGatewayCapabilityConfig", () => {
  it("defaults all capabilities to enabled when gatewayRpc is unset", () => {
    const caps = resolveGatewayCapabilityConfig(makeCfg({ clientId: "id" }));
    expect(caps).toEqual({ docsEnabled: true, proactiveSendEnabled: true });
    expect(caps.allowedSpaceIds).toBeUndefined();
    expect(caps.allowedTargets).toBeUndefined();
  });

  it("honors tools.docs / tools.proactiveSend explicit false", () => {
    const caps = resolveGatewayCapabilityConfig(
      makeCfg({ gatewayRpc: { tools: { docs: false, proactiveSend: false } } }),
    );
    expect(caps.docsEnabled).toBe(false);
    expect(caps.proactiveSendEnabled).toBe(false);
  });

  it("resolves allowlists", () => {
    const caps = resolveGatewayCapabilityConfig(
      makeCfg({
        gatewayRpc: {
          docs: { allowedSpaceIds: ["spaceA"] },
          send: { allowedTargets: ["user:u1", "group:g1"] },
        },
      }),
    );
    expect(caps.allowedSpaceIds).toEqual(["spaceA"]);
    expect(caps.allowedTargets).toEqual(["user:u1", "group:g1"]);
  });

  it("named accounts inherit channel-level gatewayRpc defaults", () => {
    const cfg = makeCfg({
      gatewayRpc: { tools: { docs: false } },
      accounts: { bot2: { clientId: "x" } },
    }) as OpenClawConfig & { channels: { dingtalk: { accounts: Record<string, unknown> } } };
    const caps = resolveGatewayCapabilityConfig(cfg, "bot2");
    expect(caps.docsEnabled).toBe(false);
    expect(caps.proactiveSendEnabled).toBe(true);
  });

  it("account-level gatewayRpc overrides channel-level", () => {
    const cfg = makeCfg({
      gatewayRpc: { tools: { docs: false } },
      accounts: { bot2: { gatewayRpc: { tools: { docs: true } } } },
    }) as OpenClawConfig & { channels: { dingtalk: { accounts: Record<string, unknown> } } };
    const caps = resolveGatewayCapabilityConfig(cfg, "bot2");
    expect(caps.docsEnabled).toBe(true);
  });
});

describe("checkDocsGatewayCapability", () => {
  it("returns null when enabled and no allowlist", () => {
    const caps = resolveGatewayCapabilityConfig(makeCfg({}));
    expect(checkDocsGatewayCapability(caps, "spaceA")).toBeNull();
  });

  it("denies when docs tool disabled", () => {
    const caps = resolveGatewayCapabilityConfig(makeCfg({ gatewayRpc: { tools: { docs: false } } }));
    const denial = checkDocsGatewayCapability(caps, "spaceA");
    expect(denial).toContain("disabled by config");
  });

  it("denies spaceId outside allowlist", () => {
    const caps = resolveGatewayCapabilityConfig(
      makeCfg({ gatewayRpc: { docs: { allowedSpaceIds: ["spaceA"] } } }),
    );
    expect(checkDocsGatewayCapability(caps, "spaceB")).toContain("allowedSpaceIds");
    expect(checkDocsGatewayCapability(caps, undefined)).toContain("allowedSpaceIds");
    expect(checkDocsGatewayCapability(caps, "spaceA")).toBeNull();
  });
});

describe("checkProactiveSendGatewayCapability", () => {
  it("returns null when enabled and no allowlist", () => {
    const caps = resolveGatewayCapabilityConfig(makeCfg({}));
    expect(checkProactiveSendGatewayCapability(caps, "user:u1")).toBeNull();
  });

  it("denies when proactiveSend disabled", () => {
    const caps = resolveGatewayCapabilityConfig(
      makeCfg({ gatewayRpc: { tools: { proactiveSend: false } } }),
    );
    const denial = checkProactiveSendGatewayCapability(caps, "user:u1");
    expect(denial).toContain("disabled by config");
  });

  it("denies target outside allowlist", () => {
    const caps = resolveGatewayCapabilityConfig(
      makeCfg({ gatewayRpc: { send: { allowedTargets: ["group:g1"] } } }),
    );
    expect(checkProactiveSendGatewayCapability(caps, "user:u1")).toContain("allowedTargets");
    expect(checkProactiveSendGatewayCapability(caps, "group:g1")).toBeNull();
  });
});
