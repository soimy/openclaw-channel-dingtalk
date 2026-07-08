import { describe, expect, it } from "vitest";
import {
  normalizeModelDisplayName,
  resolveConfiguredTaskModelMetadata,
} from "../../src/card/task-model-metadata";

describe("task-model-metadata", () => {
  it("displays the model segment from provider/model refs", () => {
    expect(normalizeModelDisplayName("deepseek/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelDisplayName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
    expect(normalizeModelDisplayName("  openai/gpt-4o  ")).toBe("gpt-4o");
  });

  it("returns undefined for blank model refs", () => {
    expect(normalizeModelDisplayName("")).toBeUndefined();
    expect(normalizeModelDisplayName("   ")).toBeUndefined();
  });

  it("uses agent-specific model and thinking default before global defaults", () => {
    const result = resolveConfiguredTaskModelMetadata({
      cfg: {
        agents: {
          defaults: { model: "openai/gpt-4o", thinkingDefault: "low" },
          list: [
            {
              id: "main",
              model: { primary: "deepseek/deepseek-v4-pro" },
              thinkingDefault: "high",
            },
          ],
        },
      } as any,
      agentId: "main",
    });

    expect(result).toEqual({ model: "deepseek-v4-pro", effort: "high" });
  });

  it("falls back to agents.defaults when the routed agent has no model", () => {
    const result = resolveConfiguredTaskModelMetadata({
      cfg: {
        agents: {
          defaults: { model: "anthropic/claude-sonnet-4-20250514", thinkingDefault: "medium" },
          list: [{ id: "main" }],
        },
      } as any,
      agentId: "main",
    });

    expect(result).toEqual({ model: "claude-sonnet-4-20250514", effort: "medium" });
  });

  it("returns empty metadata when no configured model exists", () => {
    expect(resolveConfiguredTaskModelMetadata({ cfg: {} as any, agentId: "main" })).toEqual({
      model: undefined,
      effort: undefined,
    });
  });
});
