import { describe, expect, it } from "vitest";
import { parseApproveCommand } from "../../src/approval/approval-command-parser";

const ALIAS_ALLOW_ONCE = ["allow", "once", "allow-once", "allowonce"] as const;
const ALIAS_ALLOW_ALWAYS = ["always", "allow-always", "allowalways"] as const;
const ALIAS_DENY = ["deny", "reject", "block"] as const;

describe("parseApproveCommand", () => {
  describe("order A: /approve <id> <decision>", () => {
    for (const alias of ALIAS_ALLOW_ONCE) {
      it(`/approve abc ${alias} -> allow-once`, () => {
        expect(parseApproveCommand(`/approve abc ${alias}`)).toEqual({
          approvalId: "abc",
          decision: "allow-once",
        });
      });
    }

    for (const alias of ALIAS_ALLOW_ALWAYS) {
      it(`/approve abc ${alias} -> allow-always`, () => {
        expect(parseApproveCommand(`/approve abc ${alias}`)).toEqual({
          approvalId: "abc",
          decision: "allow-always",
        });
      });
    }

    for (const alias of ALIAS_DENY) {
      it(`/approve abc ${alias} -> deny`, () => {
        expect(parseApproveCommand(`/approve abc ${alias}`)).toEqual({
          approvalId: "abc",
          decision: "deny",
        });
      });
    }
  });

  describe("order B: /approve <decision> <id>", () => {
    for (const alias of ALIAS_ALLOW_ONCE) {
      it(`/approve ${alias} abc -> allow-once`, () => {
        expect(parseApproveCommand(`/approve ${alias} abc`)).toEqual({
          approvalId: "abc",
          decision: "allow-once",
        });
      });
    }

    for (const alias of ALIAS_ALLOW_ALWAYS) {
      it(`/approve ${alias} abc -> allow-always`, () => {
        expect(parseApproveCommand(`/approve ${alias} abc`)).toEqual({
          approvalId: "abc",
          decision: "allow-always",
        });
      });
    }

    for (const alias of ALIAS_DENY) {
      it(`/approve ${alias} abc -> deny`, () => {
        expect(parseApproveCommand(`/approve ${alias} abc`)).toEqual({
          approvalId: "abc",
          decision: "deny",
        });
      });
    }
  });

  it("accepts bare approve without a leading slash", () => {
    expect(parseApproveCommand("approve abc once")).toEqual({
      approvalId: "abc",
      decision: "allow-once",
    });
  });

  it("matches decision aliases case-insensitively", () => {
    expect(parseApproveCommand("/approve abc ALLOW")).toEqual({
      approvalId: "abc",
      decision: "allow-once",
    });
  });

  it("preserves approvalId casing", () => {
    expect(parseApproveCommand("/approve ABC-123 deny")?.approvalId).toBe("ABC-123");
  });

  it("returns null for malformed commands", () => {
    expect(parseApproveCommand("/approve")).toBeNull();
    expect(parseApproveCommand("/approve abc")).toBeNull();
    expect(parseApproveCommand("/approve abc xyz")).toBeNull();
    expect(parseApproveCommand("approve foo bar baz qux")).toBeNull();
    expect(parseApproveCommand("")).toBeNull();
  });

  it("keeps the alias count aligned with upstream commands-approve", () => {
    expect(ALIAS_ALLOW_ONCE.length + ALIAS_ALLOW_ALWAYS.length + ALIAS_DENY.length).toBe(10);
  });
});
