import { describe, expect, it } from "vitest";

import { parseLearnCommand } from "../../src/learning-command-service";
import { parseSummaryCommand } from "../../src/summary-command-service";

describe("learning-command-service", () => {
  it("parses /learn here without requiring a target head", () => {
    expect(parseLearnCommand("/learn here #@# 引用规则")).toEqual({
      scope: "here",
      instruction: "引用规则",
    });
  });

  it("does not parse session alias commands", () => {
    expect(parseLearnCommand("/session-alias show")).toEqual({
      scope: "unknown",
    });
  });

  it("parses summary filters and time window", () => {
    const parsed = parseSummaryCommand("/summary group 3d", 1_700_000_000_000);
    expect(parsed).toEqual({
      scope: "summary",
      chatType: "group",
      sinceTs: 1_700_000_000_000 - 3 * 24 * 60 * 60 * 1000,
      windowLabel: "最近 3 天",
    });
  });

  it("parses summary mention filter", () => {
    const parsed = parseSummaryCommand("/summary mention @小明 12h", 1_700_000_000_000);
    expect(parsed).toEqual({
      scope: "summary",
      mentionNames: ["小明"],
      sinceTs: 1_700_000_000_000 - 12 * 60 * 60 * 1000,
      windowLabel: "最近 12 小时",
    });
  });

  it("parses summary mention self alias", () => {
    const parsed = parseSummaryCommand("/summary mention me 1d", 1_700_000_000_000);
    expect(parsed).toEqual({
      scope: "summary",
      mentionNames: ["me"],
      sinceTs: 1_700_000_000_000 - 24 * 60 * 60 * 1000,
      windowLabel: "最近 1 天",
    });
  });
});
