// tests/unit/statusline-renderer.test.ts
import { describe, it, expect } from "vitest";
import { formatTokenCount, formatDuration, renderStatusLine } from "../../src/card/statusline-renderer";
import type { StatusLineData, StatusLineConfig } from "../../src/card/statusline-renderer";

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("formats exact million", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  it("formats thousands", () => {
    expect(formatTokenCount(12_500)).toBe("12.5k");
  });

  it("formats exact thousand", () => {
    expect(formatTokenCount(1_000)).toBe("1.0k");
  });

  it("keeps small numbers as-is", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120)).toBe("2m 0s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("renderStatusLine", () => {
  const fullData: StatusLineData = {
    model: "claude-sonnet-4-20250514",
    effort: "high",
    agent: "MyBot",
    taskTime: 125,
    inputTokens: 45_200,
    outputTokens: 28_700,
    cacheRead: 32_100,
    dapi_usage: 23,
  };

  it("renders default config (model + effort + agent only)", () => {
    const config: StatusLineConfig = {};
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | high | MyBot",
    );
  });

  it("renders all segments enabled", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: true,
      cardStatusAgent: true,
      cardStatusTaskTime: true,
      cardStatusTokens: true,
      cardStatusDapiUsage: true,
    };
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | high | MyBot\n↑45.2k(C:32.1k) ↓28.7k | 2m 5s | DAPI+23",
    );
  });

  it("hides disabled segments", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | ↑45.2k(C:32.1k) ↓28.7k",
    );
  });

  it("omits cache parenthetical when cacheRead is 0", () => {
    const data: StatusLineData = {
      inputTokens: 1_200,
      outputTokens: 800,
      cacheRead: 0,
    };
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(data, config)).toBe("↑1.2k ↓800");
  });

  it("omits cache parenthetical when cacheRead is undefined", () => {
    const data: StatusLineData = {
      inputTokens: 5_000,
      outputTokens: 2_000,
    };
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(data, config)).toBe("↑5.0k ↓2.0k");
  });

  it("returns empty string when all segments disabled or empty", () => {
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
    };
    expect(renderStatusLine({}, config)).toBe("");
  });

  it("skips segments whose data is missing even if enabled", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusTaskTime: true,
      cardStatusTokens: true,
    };
    const data: StatusLineData = { model: "gpt-4o" };
    expect(renderStatusLine(data, config)).toBe("gpt-4o");
  });

  it("renders only model + tokens (minimal + tokens)", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    const data: StatusLineData = {
      model: "claude-sonnet-4-20250514",
      inputTokens: 12_500,
      outputTokens: 3_500,
      cacheRead: 8_100,
    };
    expect(renderStatusLine(data, config)).toBe(
      "claude-sonnet-4-20250514 | ↑12.5k(C:8.1k) ↓3.5k",
    );
  });
});
