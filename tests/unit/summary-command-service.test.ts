import { describe, expect, it } from "vitest";

import {
  formatSummaryCommandHelp,
  parseSummaryCommand,
  resolveSummaryMentionNames,
} from "../../src/commands/summary-command-service";

describe("summary-command-service", () => {
  it("parses summary mention and here scopes", () => {
    expect(parseSummaryCommand("/summary mention @Alice,me 1d", 2000)).toEqual({
      scope: "summary",
      mentionNames: ["Alice", "me"],
      sinceTs: 2000 - 24 * 60 * 60 * 1000,
      windowLabel: "最近 1 天",
    });

    const parsedToday = parseSummaryCommand("/summary here today", 2000);
    expect(parsedToday).toEqual(expect.objectContaining({
      scope: "summary",
      useCurrentConversation: true,
      windowLabel: "今天",
    }));
    expect(typeof parsedToday.sinceTs).toBe("number");
  });

  it("resolves mention self alias and formats help", () => {
    expect(resolveSummaryMentionNames(["me", "Alice"], "Bob")).toEqual(["Bob", "Alice"]);
    expect(formatSummaryCommandHelp()).toContain("/summary mention");
  });
});
