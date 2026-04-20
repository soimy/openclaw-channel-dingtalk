export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export interface StatusLineData {
  model?: string;
  effort?: string;
  agent?: string;
  taskTime?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  dapi_usage?: number;
}

export interface StatusLineConfig {
  cardStatusModel?: boolean;
  cardStatusEffort?: boolean;
  cardStatusAgent?: boolean;
  cardStatusTaskTime?: boolean;
  cardStatusTokens?: boolean;
  cardStatusDapiUsage?: boolean;
}

interface Segment {
  configKey: keyof StatusLineConfig;
  defaultOn: boolean;
  render: (d: StatusLineData) => string | undefined;
}

function renderTokenSegment(data: StatusLineData): string | undefined {
  const parts: string[] = [];
  if (typeof data.inputTokens === "number") {
    let s = `↑${formatTokenCount(data.inputTokens)}`;
    if (typeof data.cacheRead === "number" && data.cacheRead > 0) {
      s += `(C:${formatTokenCount(data.cacheRead)})`;
    }
    parts.push(s);
  }
  if (typeof data.outputTokens === "number") {
    parts.push(`↓${formatTokenCount(data.outputTokens)}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const SEGMENTS: Segment[] = [
  { configKey: "cardStatusModel", defaultOn: true, render: (d) => d.model || undefined },
  { configKey: "cardStatusEffort", defaultOn: true, render: (d) => d.effort || undefined },
  { configKey: "cardStatusAgent", defaultOn: true, render: (d) => d.agent || undefined },
  { configKey: "cardStatusTaskTime", defaultOn: false, render: (d) => typeof d.taskTime === "number" ? formatDuration(d.taskTime) : undefined },
  { configKey: "cardStatusTokens", defaultOn: false, render: renderTokenSegment },
  { configKey: "cardStatusDapiUsage", defaultOn: false, render: (d) => typeof d.dapi_usage === "number" ? `API×${d.dapi_usage}` : undefined },
];

const SEGMENTS_PER_LINE = 3;

export function renderStatusLine(data: StatusLineData, config: StatusLineConfig): string {
  const rendered = SEGMENTS
    .filter((seg) => config[seg.configKey] ?? seg.defaultOn)
    .map((seg) => seg.render(data))
    .filter(Boolean) as string[];

  if (rendered.length === 0) { return ""; }

  const lines: string[] = [];
  for (let i = 0; i < rendered.length; i += SEGMENTS_PER_LINE) {
    lines.push(rendered.slice(i, i + SEGMENTS_PER_LINE).join(" | "));
  }
  return lines.join("\n");
}
