import { describe, expect, it } from "vitest";
import { DingTalkConfigSchema } from "../../src/config-schema";

describe("DingTalkConfigSchema · execApprovals", () => {
  it("accepts enabled=auto with approvers", () => {
    const parsed = DingTalkConfigSchema.parse({
      clientId: "x",
      clientSecret: "y",
      execApprovals: { enabled: "auto", approvers: ["staff001"] },
    });

    expect(parsed.execApprovals?.enabled).toBe("auto");
    expect(parsed.execApprovals?.approvers).toEqual(["staff001"]);
  });

  it("accepts enabled=true and enabled=false", () => {
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x",
        clientSecret: "y",
        execApprovals: { enabled: true, approvers: [] },
      }),
    ).not.toThrow();
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x",
        clientSecret: "y",
        execApprovals: { enabled: false },
      }),
    ).not.toThrow();
  });

  it("allows omitting execApprovals for backward compatibility", () => {
    expect(() => DingTalkConfigSchema.parse({ clientId: "x", clientSecret: "y" })).not.toThrow();
  });

  it("requires approver entries to be strings", () => {
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x",
        clientSecret: "y",
        execApprovals: { approvers: [123 as unknown as string] },
      }),
    ).toThrow();
  });

  it("rejects v2 future fields target and ttlMs", () => {
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x",
        clientSecret: "y",
        execApprovals: { approvers: ["staff001"], target: "dm" } as never,
      }),
    ).toThrow();
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x",
        clientSecret: "y",
        execApprovals: { approvers: ["staff001"], ttlMs: 600000 } as never,
      }),
    ).toThrow();
  });
});
