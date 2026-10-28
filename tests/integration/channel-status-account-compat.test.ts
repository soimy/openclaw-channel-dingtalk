import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { dingtalkPlugin } from "../../src/channel";
import { resolveDingTalkAccount } from "../../src/platform/config";

let stateDir: string;
let status: (input: unknown) => Promise<void>;
let restoreRegistry: () => void;
let probe: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dingtalk-sdk-status-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", join(stateDir, "openclaw.json"));
  const dist = resolve(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/core")), "..");
  const files = readdirSync(dist).filter((name) => name.endsWith(".js"));
  const load = async (prefix: string, marker: string) => {
    const file = files.find((name) => name.startsWith(prefix) && readFileSync(join(dist, name), "utf8").includes(marker));
    if (!file) throw new Error(`Pinned OpenClaw SDK bundle not found: ${marker}`);
    return import(/* @vite-ignore */ pathToFileURL(join(dist, file)).href);
  };
  // Register the real plugin in the host's in-memory registry; do not mock status/default resolution.
  const runtime = await load("runtime-", "function setActivePluginRegistry(");
  const find = (name: string) => Object.values(runtime).find((value) => typeof value === "function" && value.name === name) as (...args: unknown[]) => unknown;
  const saved = find("captureActivePluginRegistrySnapshot")();
  restoreRegistry = () => { find("restoreActivePluginRegistrySnapshot")(saved); };
  find("setActivePluginRegistry")({ plugins: [], channels: [{ pluginId: "dingtalk", plugin: dingtalkPlugin }], sessionExtensions: [], runtimeLifecycles: [], agentEventSubscriptions: [], sessionSchedulerJobs: [] });
  status = (await load("channels-", "const channelsHandlers = {")).channelsHandlers["channels.status"];
  // probe:false must never reach the network, even if the host regresses.
  probe = vi.spyOn(dingtalkPlugin.status!, "probeAccount").mockRejectedValue(new Error("network probe disabled"));
});

afterAll(() => {
  probe?.mockRestore();
  restoreRegistry?.();
  vi.unstubAllEnvs();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function configFor(ids: string[], rootCredentials = false): OpenClawConfig {
  return { plugins: { enabled: false }, channels: { dingtalk: {
    ...(rootCredentials ? { clientId: "root-id", clientSecret: "test-secret" } : {}),
    accounts: Object.fromEntries(ids.map((id) => [id, { clientId: `bot-${id}`, clientSecret: "test-secret" }])),
  } } } as OpenClawConfig;
}

async function readStatus(cfg: OpenClawConfig) {
  const respond = vi.fn();
  await status({ params: { probe: false }, respond, context: {
    getRuntimeConfig: () => cfg,
    getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
  } });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  expect(probe).not.toHaveBeenCalled();
  return respond.mock.calls[0][1];
}

describe("real SDK channels.status default account compatibility", () => {
  it.each([
    { ids: ["Default"], root: false, expected: "Default" },
    { ids: [" default "], root: false, expected: " default " },
    { ids: ["Main"], root: false, expected: "default" },
    { ids: ["default"], root: false, expected: "default" },
    { ids: ["secondary", "Default"], root: false, expected: "Default" },
    { ids: ["secondary"], root: true, expected: "default" },
    { ids: [], root: true, expected: "default" },
    { ids: ["default", "secondary"], root: true, expected: "default" },
  ])("returns complete status for $ids with root=$root", async ({ ids, root, expected }) => {
    const cfg = configFor(ids, root);
    const payload = await readStatus(cfg);
    expect(payload.partial).not.toBe(true);
    expect(payload.channels.dingtalk).toBeDefined();
    expect(payload.channelAccounts.dingtalk.map((entry: { accountId: string }) => entry.accountId)).toEqual(ids.length ? ids : ["default"]);
    expect(payload.channelDefaultAccountId.dingtalk).toBe(expected);
  });

  it.each(["Default", " default "])("keeps unspecified default resolution consistent for %j", (id) => {
    const cfg = configFor([id]);
    for (const accountId of [undefined, null]) {
      expect(dingtalkPlugin.config.resolveAccount(cfg, accountId).accountId).toBe(id);
      expect(resolveDingTalkAccount(cfg, accountId).accountId).toBe(id);
    }
    expect(() => dingtalkPlugin.config.resolveAccount(cfg, "default")).toThrow(/pairing identity/);
    expect(() => resolveDingTalkAccount(cfg, "default")).toThrow(/pairing identity/);
  });

  it("still rejects real account collisions instead of making status merge their identities", async () => {
    const payload = await readStatus(configFor(["Main", "main"]));
    expect(payload.partial).toBe(true);
    expect(payload.channels.dingtalk).toBeUndefined();
    expect(payload.warnings.join(" ")).toMatch(/pairing identity/);
  });
});
