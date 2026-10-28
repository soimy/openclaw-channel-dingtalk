import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  getConfig,
  listDingTalkAccountIds,
  resolveDingTalkAccount,
} from "../../src/platform/config";
import { DingTalkConfigSchema } from "../../src/platform/config-schema";

function configFor(ids: string[], withDefault = false): OpenClawConfig {
  return { channels: { dingtalk: {
    ...(withDefault ? { clientId: "root-id", clientSecret: "root-secret" } : {}),
    dmPolicy: "pairing",
    accounts: Object.fromEntries(ids.map((id, index) => [id, { clientId: `bot-${index}`, clientSecret: "test-secret" }])),
  } } } as OpenClawConfig;
}

describe("DingTalk account identity validation", () => {
  it.each([
    ["Main", "main"],
    ["primary", "primary "],
    ["primary", " primary"],
    ["primary", "\tPRIMARY\n"],
  ])("rejects colliding keys %j and %j in schema and account resolvers", (first, second) => {
    const cfg = configFor([first, second]);
    expect(() => DingTalkConfigSchema.parse(cfg.channels?.dingtalk)).toThrow(/pairing identity/);
    expect(() => getConfig(cfg)).toThrow(/pairing identity/);
    expect(() => getConfig(cfg, first)).toThrow(JSON.stringify(second));
    expect(() => listDingTalkAccountIds(cfg)).toThrow(JSON.stringify(first));
    expect(() => resolveDingTalkAccount(cfg, second)).toThrow(/pairing identity/);
  });

  it.each(["Default", " default "])("includes implicit default when checking %j", (id) => {
    const cfg = configFor([id], true);
    expect(() => DingTalkConfigSchema.parse(cfg.channels?.dingtalk)).toThrow(/default.*pairing identity/);
    expect(() => getConfig(cfg, id)).toThrow(/default.*pairing identity/);
    expect(() => listDingTalkAccountIds(cfg)).toThrow(/pairing identity/);
  });

  it.each(["", " ", "\t\n"])("rejects an empty configured account ID %j", (id) => {
    const cfg = configFor([id]);
    expect(() => DingTalkConfigSchema.parse(cfg.channels?.dingtalk)).toThrow(/empty or whitespace/);
    expect(() => getConfig(cfg)).toThrow(/empty or whitespace/);
  });

  it.each(["", " "])("rejects explicitly blank requested account ID %j", (id) => {
    const cfg = configFor([], true);
    expect(() => getConfig(cfg, id)).toThrow(/empty or whitespace/);
    expect(() => resolveDingTalkAccount(cfg, id)).toThrow(/empty or whitespace/);
  });

  it("rejects a requested normalized alias instead of falling back to root credentials", () => {
    const cfg = configFor(["Main"], true);
    expect(() => getConfig(cfg, "main")).toThrow(/pairing identity/);
    expect(() => resolveDingTalkAccount(cfg, "main")).toThrow(/pairing identity/);
  });

  it("keeps explicit accounts.default as one account and preserves config inheritance", () => {
    const cfg = configFor(["default", "secondary"], true);
    const channel = cfg.channels!.dingtalk as Record<string, unknown>;
    channel.allowFrom = ["owner"];
    expect(DingTalkConfigSchema.safeParse(channel).success).toBe(true);
    expect(listDingTalkAccountIds(cfg)).toEqual(["default", "secondary"]);
    expect(getConfig(cfg, "default")).toMatchObject({ clientId: "bot-0", allowFrom: ["owner"], dmPolicy: "pairing" });
    expect(resolveDingTalkAccount(cfg, null)).toMatchObject({ accountId: "default", clientId: "bot-0" });
  });

  it("preserves unambiguous raw IDs instead of silently renaming them", () => {
    const cfg = configFor(["Main", " secondary "]);
    expect(DingTalkConfigSchema.safeParse(cfg.channels?.dingtalk).success).toBe(true);
    expect(listDingTalkAccountIds(cfg)).toEqual(["Main", " secondary "]);
    expect(resolveDingTalkAccount(cfg, "Main").accountId).toBe("Main");
    expect(getConfig(cfg, " secondary ").clientId).toBe("bot-1");
  });

  it("checks disabled accounts too, without rejecting distinct SDK SQLite identities", () => {
    const cfg = configFor(["Main", "main"]);
    (cfg.channels!.dingtalk as { accounts: Record<string, { enabled?: boolean }> }).accounts.main.enabled = false;
    expect(() => getConfig(cfg)).toThrow(/pairing identity/);
    expect(DingTalkConfigSchema.safeParse(configFor(["team/a", "team_a"]).channels?.dingtalk).success).toBe(true);
  });

  it.each(["open", "allowlist"])("does not bypass collision validation with dmPolicy=%s", (dmPolicy) => {
    const cfg = configFor(["Main", "main"]);
    Object.assign(cfg.channels!.dingtalk!, { dmPolicy, allowFrom: ["*"] });
    expect(() => getConfig(cfg)).toThrow(/pairing identity/);
  });
});
