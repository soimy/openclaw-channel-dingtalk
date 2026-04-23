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
  cardStatusLine?: {
    model?: boolean;
    effort?: boolean;
    agent?: boolean;
    taskTime?: boolean;
    tokens?: boolean;
    dapiUsage?: boolean;
  };
}

type SegmentKey = "model" | "effort" | "agent" | "tokens" | "taskTime" | "dapiUsage";

interface Segment {
  key: SegmentKey;
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
  { key: "model", defaultOn: true, render: (d) => d.model || undefined },
  { key: "effort", defaultOn: true, render: (d) => d.effort || undefined },
  { key: "agent", defaultOn: true, render: (d) => d.agent || undefined },
  { key: "tokens", defaultOn: false, render: renderTokenSegment },
  { key: "taskTime", defaultOn: false, render: (d) => typeof d.taskTime === "number" ? formatDuration(d.taskTime) : undefined },
  { key: "dapiUsage", defaultOn: false, render: (d) => typeof d.dapi_usage === "number" ? `DAPI+${d.dapi_usage}` : undefined },
];

const SEGMENTS_PER_LINE = 3;

function resolveSegmentEnabled(seg: Segment, config: StatusLineConfig): boolean {
  const value = config.cardStatusLine?.[seg.key];
  return typeof value === "boolean" ? value : seg.defaultOn;
}

export function renderStatusLine(data: StatusLineData, config: StatusLineConfig): string {
  const rendered = SEGMENTS
    .filter((seg) => resolveSegmentEnabled(seg, config))
    .map((seg) => seg.render(data))
    .filter(Boolean) as string[];

  if (rendered.length === 0) { return ""; }

  const lines: string[] = [];
  for (let i = 0; i < rendered.length; i += SEGMENTS_PER_LINE) {
    lines.push(rendered.slice(i, i + SEGMENTS_PER_LINE).join(" | "));
  }
  return lines.join("\n");
}
