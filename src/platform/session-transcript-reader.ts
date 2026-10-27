/** Minimal public raw-delta contract, capability-checked at the SDK boundary.
 * OpenClaw 2026.8.1 exports this JS entry but omits its entry-point declaration.
 * Do not import the host's private hashed bundles or legacy file materializers.
 */
export type TranscriptPage =
  | { kind: "missing" }
  | { kind: "reset"; cursor: string; reason: string }
  | {
      kind: "page";
      cursor: string;
      events: Array<{ event: unknown; seq: number }>;
      hasMore: boolean;
      requiredBytes?: number;
      serializedBytes: number;
    };
export type TranscriptPageTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  cursor?: string;
  maxBytes: number;
  maxEvents: number;
};

export async function readHostTranscriptPage(
  target: TranscriptPageTarget,
): Promise<TranscriptPage> {
  const entryPoint = "openclaw/plugin-sdk/session-transcript-runtime";
  const sdk: unknown = await import(entryPoint);
  if (
    !sdk ||
    typeof sdk !== "object" ||
    !("readSessionTranscriptRawDelta" in sdk) ||
    typeof sdk.readSessionTranscriptRawDelta !== "function"
  ) {
    throw new Error("bounded_reader_unavailable");
  }
  const result: unknown = await sdk.readSessionTranscriptRawDelta(target);
  if (!result || typeof result !== "object" || !("kind" in result)) {
    throw new Error("invalid_transcript_page");
  }
  if (result.kind === "missing") {
    return { kind: "missing" };
  }
  if (result.kind === "reset") {
    return { kind: "reset", cursor: "", reason: "transcript_changed" };
  }
  if (
    result.kind !== "page" ||
    !("events" in result) ||
    !Array.isArray(result.events) ||
    !("cursor" in result) ||
    typeof result.cursor !== "string" ||
    !("hasMore" in result) ||
    typeof result.hasMore !== "boolean" ||
    !("serializedBytes" in result) ||
    typeof result.serializedBytes !== "number" ||
    !Number.isSafeInteger(result.serializedBytes) ||
    result.serializedBytes < 0 ||
    result.serializedBytes > target.maxBytes ||
    result.events.length > target.maxEvents
  ) {
    throw new Error("invalid_transcript_page");
  }
  return result as TranscriptPage;
}
