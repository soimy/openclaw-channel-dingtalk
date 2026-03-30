import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDingTalkRuntime } from "../../src/runtime";
import {
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "../../src/targeting/target-directory-store";

vi.mock("openclaw/plugin-sdk", () => ({
  buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock("dingtalk-stream", () => ({
  TOPIC_CARD: "TOPIC_CARD",
  DWClient: vi.fn(),
  TOPIC_ROBOT: "TOPIC_ROBOT",
}));

import { dingtalkPlugin } from "../../src/channel";

const plugin = dingtalkPlugin as any;
const displayNameResolutionAllCfg = {
  channels: {
    dingtalk: {
      displayNameResolution: "all",
    },
  },
} as any;

describe("channel config + status helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createStorePath(): string {
    const dir = path.join(
      os.tmpdir(),
      `openclaw-dingtalk-channel-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(dir);
    return path.join(dir, "sessions.json");
  }

  it("resolves account list and account metadata", () => {
    const cfg = {
      channels: {
        dingtalk: {
          accounts: {
            main: { clientId: "id1", clientSecret: "sec1", enabled: true, name: "Main" },
            backup: { clientId: "id2", clientSecret: "sec2", enabled: false },
          },
        },
      },
    } as any;

    const ids = plugin.config.listAccountIds(cfg);
    const account = plugin.config.resolveAccount(cfg, "main");

    expect(ids).toEqual(["main", "backup"]);
    expect(account.accountId).toBe("main");
    expect(account.configured).toBe(true);
    expect(plugin.config.describeAccount(account).name).toBe("Main");
  });

  it("resolveAccount merges channel-level defaults into named account", () => {
    const cfg = {
      channels: {
        dingtalk: {
          dmPolicy: "allowlist",
          allowFrom: ["user1"],
          messageType: "card",
          ackReaction: "",
          accounts: {
            main: { clientId: "id1", clientSecret: "sec1", name: "Main" },
            custom: { clientId: "id2", clientSecret: "sec2", dmPolicy: "open" },
          },
        },
      },
    } as any;

    const main = plugin.config.resolveAccount(cfg, "main");
    expect(main.config.clientId).toBe("id1");
    expect(main.config.dmPolicy).toBe("allowlist");
    expect(main.config.allowFrom).toEqual(["user1"]);
    expect(main.config.messageType).toBe("card");
    expect(main.config.ackReaction).toBe("");

    const custom = plugin.config.resolveAccount(cfg, "custom");
    expect(custom.config.dmPolicy).toBe("open");
    expect(custom.config.messageType).toBe("card");
  });

  it("validates outbound resolveTarget and messaging/security helpers", () => {
    const resolved = plugin.outbound.resolveTarget({ to: "group:cidAbC" } as any);
    const invalid = plugin.outbound.resolveTarget({ to: "   " } as any);

    expect(resolved).toEqual({ ok: true, to: "cidAbC" });
    expect(invalid.ok).toBe(false);
    expect(plugin.messaging.normalizeTarget("dingtalk:user_1")).toBe("user_1");
    expect(plugin.messaging.normalizeTarget("dingtalk:group:cidAbC")).toBe("cidAbC");
    expect(plugin.messaging.normalizeTarget("dingtalk: user:staff_1")).toBe("staff_1");
    expect(plugin.messaging.targetResolver.hint).toContain("displayName");
    expect(plugin.messaging.targetResolver.looksLikeId("cidAbC")).toBe(true);
    expect(plugin.messaging.targetResolver.looksLikeId("user:staff_1")).toBe(true);
    expect(plugin.messaging.targetResolver.looksLikeId("+8613800138000")).toBe(true);
    expect(plugin.messaging.targetResolver.looksLikeId("abcdefghijklmnop")).toBe(false);
    expect(plugin.messaging.targetResolver.looksLikeId("研发-日报群")).toBe(false);
    expect(plugin.messaging.targetResolver.looksLikeId("研发群")).toBe(false);

    const dmPolicy = plugin.security.resolveDmPolicy({ account: { config: {} } } as any);
    expect(dmPolicy.policy).toBe("open");
    expect(dmPolicy.normalizeEntry("dd:User1")).toBe("User1");
  });

  it("builds status summary and issues from account snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      const issues = plugin.status.collectStatusIssues([
        { accountId: "a1", configured: false },
        { accountId: "a2", configured: true },
      ] as any);

      const summary = plugin.status.buildChannelSummary({
        snapshot: { configured: true, running: false, lastError: "err" },
      } as any);

      const snap = plugin.status.buildAccountSnapshot({
        account: {
          accountId: "a1",
          name: "A1",
          enabled: true,
          configured: true,
          config: { clientId: "id1" },
        },
        runtime: { running: true, lastStartAt: 1, lastStopAt: null, lastError: null },
        snapshot: {},
        probe: { ok: true },
      } as any);

      const stoppedSnap = plugin.status.buildAccountSnapshot({
        account: {
          accountId: "a1",
          name: "A1",
          enabled: true,
          configured: true,
          config: { clientId: "id1" },
        },
        runtime: {
          running: false,
          lastEventAt: 123,
          lastStartAt: 1,
          lastStopAt: null,
          lastError: null,
        },
        snapshot: {},
        probe: { ok: true },
      } as any);

      expect(issues).toHaveLength(1);
      expect(summary.lastError).toBe("err");
      expect(snap.running).toBe(true);
      expect(snap.clientId).toBe("id1");
      expect(snap.lastEventAt).toBe(Date.now());
      expect(stoppedSnap.lastEventAt).toBe(123);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists groups/peers from learned displayName directory", async () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevTeam",
      title: "Dev Team",
      seenAt: 1000,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      seenAt: 1000,
    });
    const runtime = {
      channel: {
        session: {
          resolveStorePath: vi.fn().mockReturnValue(storePath),
        },
      },
    };

    const groups = await plugin.directory.listGroups({
      cfg: displayNameResolutionAllCfg,
      accountId: "default",
      query: "Dev Team",
      runtime,
      limit: null,
    });
    const peers = await plugin.directory.listPeers({
      cfg: displayNameResolutionAllCfg,
      accountId: "default",
      query: "Alice",
      runtime,
    });

    expect(groups).toEqual([
      expect.objectContaining({
        kind: "group",
        id: "cidDevTeam",
        name: "Dev Team",
      }),
    ]);
    expect(peers).toEqual([
      expect.objectContaining({
        kind: "user",
        id: "staff_001",
        name: "Alice",
      }),
    ]);
  });

  it("uses default account store path and bypasses query filter when runtime param is missing", async () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevTeam",
      title: "Dev Team",
      seenAt: 1000,
    });
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidOpsTeam",
      title: "Ops Team",
      seenAt: 1100,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_bob",
      staffId: "staff_bob",
      displayName: "Bob",
      seenAt: 1200,
    });
    const resolveStorePath = vi
      .fn()
      .mockImplementation((_store: unknown, options: { agentId?: string }) => {
        if (options.agentId === "default") {
          return storePath;
        }
        return path.join(os.tmpdir(), `openclaw-dingtalk-wrong-store-${Date.now()}.json`);
      });
    setDingTalkRuntime({
      channel: {
        session: {
          resolveStorePath,
        },
      },
    } as any);

    const groups = await plugin.directory.listGroups({
      cfg: displayNameResolutionAllCfg,
      query: "Not Existing",
    });
    const filteredGroups = await plugin.directory.listGroups({
      cfg: displayNameResolutionAllCfg,
      query: "Ops Team",
      runtime: {
        channel: {
          session: {
            resolveStorePath,
          },
        },
      },
      limit: null,
    });

    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "default" });
    expect(groups).toHaveLength(3);
    expect(groups.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["cidDevTeam", "cidOpsTeam", "staff_bob"]),
    );
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "user",
          id: "staff_bob",
          name: "Bob",
        }),
      ]),
    );
    expect(filteredGroups).toEqual([
      expect.objectContaining({
        kind: "group",
        id: "cidOpsTeam",
        name: "Ops Team",
      }),
    ]);
  });

  it("disables learned directory resolution by default", async () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevTeam",
      title: "Dev Team",
      seenAt: 1000,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      seenAt: 1000,
    });
    const runtime = {
      channel: {
        session: {
          resolveStorePath: vi.fn().mockReturnValue(storePath),
        },
      },
    };

    const groups = await plugin.directory.listGroups({
      cfg: {} as any,
      accountId: "default",
      query: "Dev Team",
      runtime,
      limit: null,
    });
    const peers = await plugin.directory.listPeers({
      cfg: {} as any,
      accountId: "default",
      query: "Alice",
      runtime,
      limit: null,
    });

    expect(groups).toEqual([]);
    expect(peers).toEqual([]);
  });
});
