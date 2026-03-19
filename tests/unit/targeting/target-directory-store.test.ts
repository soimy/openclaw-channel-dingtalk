import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetDirectoryStateCache,
  listKnownGroupTargets,
  listKnownUserTargets,
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "../../../src/targeting/target-directory-store";

describe("target-directory-store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearTargetDirectoryStateCache();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createStorePath(): string {
    const dir = path.join(
      os.tmpdir(),
      `openclaw-dingtalk-target-directory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(dir);
    return path.join(dir, "session-store.json");
  }

  it("stores and resolves groups by current displayName", () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevGroup",
      title: "Dev Group",
      seenAt: 1000,
    });

    const groups = listKnownGroupTargets({
      storePath,
      accountId: "default",
      query: "Dev Group",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversationId).toBe("cidDevGroup");
    expect(groups[0]?.currentTitle).toBe("Dev Group");
  });

  it("keeps historical displayName for group rename tracking", () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidOps",
      title: "Ops Team",
      seenAt: 1000,
    });
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidOps",
      title: "SRE Team",
      seenAt: 2000,
    });

    const renamed = listKnownGroupTargets({
      storePath,
      accountId: "default",
      query: "SRE Team",
    });
    const historical = listKnownGroupTargets({
      storePath,
      accountId: "default",
      query: "Ops Team",
    });

    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.currentTitle).toBe("SRE Team");
    expect(renamed[0]?.historicalTitles).toContain("Ops Team");
    expect(historical).toHaveLength(1);
  });

  it("throttles lastSeenAt writes when metadata is unchanged", () => {
    const storePath = createStorePath();
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevGroup",
      title: "Dev Group",
      seenAt: 1000,
    });
    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevGroup",
      title: "Dev Group",
      seenAt: 2000,
    });

    const unchanged = listKnownGroupTargets({
      storePath,
      accountId: "default",
      query: "Dev Group",
    });
    expect(unchanged[0]?.lastSeenAt).toBe(1000);

    upsertObservedGroupTarget({
      storePath,
      accountId: "default",
      conversationId: "cidDevGroup",
      title: "Dev Group",
      seenAt: 61_500,
    });

    const refreshed = listKnownGroupTargets({
      storePath,
      accountId: "default",
      query: "Dev Group",
    });
    expect(refreshed[0]?.lastSeenAt).toBe(61_500);
  });

  it("stores and resolves users by displayName and user identifiers", () => {
    const storePath = createStorePath();
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      conversationId: "cidA",
      seenAt: 1000,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice Zhang",
      conversationId: "cidB",
      seenAt: 2000,
    });

    const byDisplayName = listKnownUserTargets({
      storePath,
      accountId: "default",
      query: "Alice Zhang",
    });
    const byHistoricalName = listKnownUserTargets({
      storePath,
      accountId: "default",
      query: "Alice",
    });
    const byStaffId = listKnownUserTargets({
      storePath,
      accountId: "default",
      query: "staff_001",
    });

    expect(byDisplayName).toHaveLength(1);
    expect(byDisplayName[0]?.canonicalUserId).toBe("staff_001");
    expect(byDisplayName[0]?.historicalDisplayNames).toContain("Alice");
    expect(byDisplayName[0]?.lastSeenInConversationIds).toEqual(["cidA", "cidB"]);
    expect(byHistoricalName).toHaveLength(1);
    expect(byStaffId).toHaveLength(1);
  });

  it("does not refresh user lastSeenAt for unchanged observations inside throttle window", () => {
    const storePath = createStorePath();
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      conversationId: "cidA",
      seenAt: 1000,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      conversationId: "cidA",
      seenAt: 2000,
    });

    const unchanged = listKnownUserTargets({
      storePath,
      accountId: "default",
      query: "Alice",
    });
    expect(unchanged[0]?.lastSeenAt).toBe(1000);

    upsertObservedUserTarget({
      storePath,
      accountId: "default",
      senderId: "union_001",
      staffId: "staff_001",
      displayName: "Alice",
      conversationId: "cidA",
      seenAt: 61_500,
    });

    const refreshed = listKnownUserTargets({
      storePath,
      accountId: "default",
      query: "Alice",
    });
    expect(refreshed[0]?.lastSeenAt).toBe(61_500);
  });

  it("is scoped by accountId when storePath is not provided", () => {
    const accountA = `a-${Date.now()}`;
    const accountB = `b-${Date.now()}`;
    upsertObservedGroupTarget({
      accountId: accountA,
      conversationId: "cidMemoryScope",
      title: "Memory Group",
      seenAt: 1000,
    });

    const groupsA = listKnownGroupTargets({
      accountId: accountA,
      query: "Memory Group",
    });
    const groupsB = listKnownGroupTargets({
      accountId: accountB,
      query: "Memory Group",
    });

    expect(groupsA).toHaveLength(1);
    expect(groupsB).toHaveLength(0);
  });
});
