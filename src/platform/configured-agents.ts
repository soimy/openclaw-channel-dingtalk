import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export interface ConfiguredAgent {
  id: string;
  name?: string;
  default?: boolean;
  model?: string | { primary?: string };
  thinkingDefault?: string;
  identity?: { emoji?: string };
}

/** 2026.10 stores agents by ID in entries; earlier hosts use an ordered list. */
export function listConfiguredAgents(cfg: OpenClawConfig): ConfiguredAgent[] {
  const agents = cfg.agents as
    | {
        list?: ConfiguredAgent[];
        entries?: Record<string, Omit<ConfiguredAgent, "id">>;
      }
    | undefined;
  if (agents?.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)) {
    return Object.entries(agents.entries).map(([id, entry]) => ({ ...entry, id }));
  }
  return Array.isArray(agents?.list) ? agents.list : [];
}
