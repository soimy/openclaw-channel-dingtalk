import { describe, expect, it } from "vitest";
import { resolveConfiguredTaskModelMetadata } from "../../src/card/task-model-metadata";
import { listConfiguredAgents } from "../../src/platform/configured-agents";
import { resolveAtAgents } from "../../src/targeting/agent-name-matcher";

describe("host agent configuration compatibility", () => {
  it("preserves legacy list order and default markers", () => {
    const list = [{ id: "other" }, { id: "main", default: true }];
    expect(listConfiguredAgents({ agents: { list } } as any)).toEqual(list);
  });
  it("takes identity from the 2026.10 entries key", () => {
    expect(
      listConfiguredAgents({
        agents: { entries: { main: { id: "spoof", name: "Assistant" } } },
      } as any),
    ).toEqual([{ id: "main", name: "Assistant" }]);
  });
  it("retains per-agent model and thinking settings in entries", () => {
    expect(
      resolveConfiguredTaskModelMetadata({
        agentId: "research",
        cfg: {
          agents: { entries: { research: { model: "provider/model", thinkingDefault: "high" } } },
        } as any,
      }),
    ).toEqual({ model: "model", effort: "high" });
  });
  it("matches a named agent in the new entries structure", () => {
    const cfg = { agents: { entries: { research: { name: "研究员" } } } } as any;
    expect(resolveAtAgents([{ name: "研究员" }], cfg).matchedAgents[0]?.agentId).toBe("research");
  });
  it("does not invent configured agents from defaults alone", () => {
    expect(listConfiguredAgents({ agents: { defaults: {} } })).toEqual([]);
  });
});
