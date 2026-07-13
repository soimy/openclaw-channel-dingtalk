import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export interface InitialTaskModelMetadata {
  model?: string;
  effort?: string;
}

type AgentModelConfigLike = string | { primary?: unknown } | undefined;

function readPrimaryModelRef(value: AgentModelConfigLike): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (value && typeof value === "object" && typeof value.primary === "string") {
    return value.primary.trim() || undefined;
  }
  return undefined;
}

export function normalizeModelDisplayName(modelRef: string | undefined): string | undefined {
  const trimmed = typeof modelRef === "string" ? modelRef.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split("/").map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) || undefined;
}

export function resolveConfiguredTaskModelMetadata(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
}): InitialTaskModelMetadata {
  const agents = params.cfg.agents;
  const agentId = String(params.agentId || "").trim();
  const agent = Array.isArray(agents?.list)
    ? agents.list.find((entry) => String(entry.id || "").trim() === agentId)
    : undefined;

  const modelRef = readPrimaryModelRef(agent?.model) ?? readPrimaryModelRef(agents?.defaults?.model);
  const effort =
    typeof agent?.thinkingDefault === "string" && agent.thinkingDefault.trim()
      ? agent.thinkingDefault.trim()
      : typeof agents?.defaults?.thinkingDefault === "string" && agents.defaults.thinkingDefault.trim()
        ? agents.defaults.thinkingDefault.trim()
        : undefined;

  return {
    model: normalizeModelDisplayName(modelRef),
    effort,
  };
}
