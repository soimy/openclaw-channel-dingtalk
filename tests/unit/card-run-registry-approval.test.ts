import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCardRunRegistryForTest,
  clearCardRunPendingApproval,
  isActiveCardRun,
  markCardRunPendingApproval,
  registerCardRun,
  resolveCardRun,
  resolveActiveCardRunBySession,
  type CardRunRecord,
} from "../../src/card/card-run-registry";
import { AICardStatus, type AICardState } from "../../src/types";

const cardWithState = (state: AICardState) =>
  ({ state }) as unknown as NonNullable<CardRunRecord["card"]>;

function makeRecord(state?: AICardState): CardRunRecord {
  return {
    outTrackId: "out-1",
    accountId: "default",
    sessionKey: "session-1",
    agentId: "agent-default",
    card: state ? cardWithState(state) : undefined,
    registeredAt: Date.now(),
  };
}

function register(
  outTrackId: string,
  options: {
    accountId?: string;
    sessionKey: string;
    agentId?: string;
    state?: AICardState;
    registeredAt?: number;
  },
): void {
  registerCardRun(outTrackId, {
    accountId: options.accountId ?? "default",
    sessionKey: options.sessionKey,
    agentId: options.agentId ?? "agent-default",
    card: options.state ? cardWithState(options.state) : undefined,
    registeredAt: options.registeredAt,
  });
}

describe("card-run-registry · approval helpers", () => {
  beforeEach(() => clearCardRunRegistryForTest());

  it("treats PROCESSING and INPUTING card runs as active", () => {
    expect(isActiveCardRun(makeRecord(AICardStatus.PROCESSING))).toBe(true);
    expect(isActiveCardRun(makeRecord(AICardStatus.INPUTING))).toBe(true);
  });

  it("treats terminal card states as inactive", () => {
    for (const state of [AICardStatus.FINISHED, AICardStatus.STOPPED, AICardStatus.FAILED]) {
      expect(isActiveCardRun(makeRecord(state))).toBe(false);
    }
  });

  it("treats records without a card as inactive", () => {
    expect(isActiveCardRun(makeRecord())).toBe(false);
  });

  it("finds an active record by accountId and sessionKey", () => {
    register("out-active", { sessionKey: "session-A", state: AICardStatus.INPUTING });

    expect(resolveActiveCardRunBySession("default", "session-A")?.outTrackId).toBe("out-active");
  });

  it("returns null when accountId does not match", () => {
    register("out-active", {
      accountId: "other",
      sessionKey: "session-A",
      state: AICardStatus.INPUTING,
    });

    expect(resolveActiveCardRunBySession("default", "session-A")).toBeNull();
  });

  it("returns null for terminal card states", () => {
    register("out-done", { sessionKey: "session-A", state: AICardStatus.FINISHED });

    expect(resolveActiveCardRunBySession("default", "session-A")).toBeNull();
  });

  it("returns null for missing session keys", () => {
    expect(resolveActiveCardRunBySession("default", "missing")).toBeNull();
  });

  it("returns the latest active record for duplicate account/session pairs", () => {
    register("out-old", {
      sessionKey: "session-A",
      state: AICardStatus.INPUTING,
      registeredAt: 1000,
    });
    register("out-new", {
      sessionKey: "session-A",
      state: AICardStatus.INPUTING,
      registeredAt: 2000,
    });

    expect(resolveActiveCardRunBySession("default", "session-A")?.outTrackId).toBe("out-new");
  });

  it("marks and clears pendingApprovalId for callback fallback", () => {
    register("out-active", { sessionKey: "session-A", state: AICardStatus.INPUTING });

    markCardRunPendingApproval(" out-active ", " approval-123 ");
    expect(resolveCardRun("out-active")?.pendingApprovalId).toBe("approval-123");

    clearCardRunPendingApproval(" out-active ");
    expect(resolveCardRun("out-active")?.pendingApprovalId).toBeUndefined();
  });
});
