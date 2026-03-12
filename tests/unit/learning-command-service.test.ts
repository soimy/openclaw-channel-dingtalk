import { describe, expect, it } from "vitest";

import { parseLearnCommand } from "../../src/learning-command-service";

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
});
