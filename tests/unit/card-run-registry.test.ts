import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCardRun,
  resolveCardRunByConversation,
  clearCardRunRegistryForTest,
} from "../../src/card/card-run-registry";

beforeEach(() => {
  clearCardRunRegistryForTest();
});

describe("resolveCardRunByConversation", () => {
  it("returns null when no runs registered", () => {
    expect(resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==")).toBeNull();
  });

  it("returns the run matching accountId and sessionKey-derived conversationId", () => {
    registerCardRun("card_abc", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    // sessionKey contains conversationId (case-insensitive)
    const result = resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==");
    expect(result).not.toBeNull();
    expect(result!.outTrackId).toBe("card_abc");
  });

  it("returns null when accountId does not match", () => {
    registerCardRun("card_abc", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    expect(resolveCardRunByConversation("other", "cid//Vc7N7lA5mymGresI0XAw==")).toBeNull();
  });

  it("returns the most recently registered run when multiple match", () => {
    registerCardRun("card_old", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
      registeredAt: Date.now() - 1000,
    });
    registerCardRun("card_new", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    const result = resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==");
    expect(result!.outTrackId).toBe("card_new");
  });
});
