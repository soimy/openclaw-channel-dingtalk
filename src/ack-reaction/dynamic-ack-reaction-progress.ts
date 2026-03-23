function readToolArgString(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Tool names here come from the runtime `onAgentEvent` tool-start payload.
 * The runtime does not expose a typed enum on this event surface yet,
 * so this mapping is intentionally best-effort and keeps a safe default.
 */
export function resolveToolProgressReaction(toolName: unknown, args: unknown): string {
  const normalizedToolName = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  switch (normalizedToolName) {
    case "bash":
    case "exec":
    case "process": {
      const command = readToolArgString(args, ["command", "cmd"]);
      if (!command) {
        return "🛠️";
      }
      if (/\bbrew\s+install\s+/i.test(command) || /\b(?:pnpm|npm|yarn)\s+(?:add|install)\s+/i.test(command)) {
        return "📦";
      }
      if (/\bwhich\s+/i.test(command)) {
        return "🔍";
      }
      return "🛠️";
    }
    case "read":
    case "view":
      return "📂";
    case "write":
    case "edit":
    case "patch":
      return "✍️";
    case "web_search":
    case "search":
    case "browser.search":
    case "browser_search":
      return "🌐";
    case "fetch":
    case "open":
    case "open_url":
    case "browser.open":
    case "browser_open":
      return "🔗";
    default:
      return "🛠️";
  }
}
