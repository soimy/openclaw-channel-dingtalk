import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { readHostTranscriptPage } from "../platform/session-transcript-reader";
import { readSmallJson } from "./feedback-reporting-io";
import type { ReportContent } from "./feedback-reporting-protocol";
import type { FeedbackRecord } from "./feedback-store";
import { resolveFeedbackTranscriptMessages } from "./feedback-transcript-content";

export type FeedbackContentRequest = {
  record: Pick<
    FeedbackRecord,
    "agentId" | "sessionKey" | "ownerUserId" | "answerHash" | "transcript"
  >;
  transcriptStorePath: string;
  config: { maxTranscriptBytes: number; maxContentBytes: number };
  metadataOnly?: boolean;
};

async function scopedLegacyPath(storePath: string, file: string): Promise<string | undefined> {
  const root = await realpath(path.dirname(storePath));
  const candidate = path.resolve(root, file);
  // Resolve aliases such as macOS /var -> /private/var even when the file is missing.
  const parent = await realpath(path.dirname(candidate));
  const actual = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return path.join(parent, path.basename(candidate));
  });
  const relative = path.relative(root, actual);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? actual : undefined;
}

/** Shared bounded reader for reporting and foreground detail workers. */
export async function collectReportContent(job: FeedbackContentRequest): Promise<ReportContent> {
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return {
      mode: "replace",
      status: "missing",
      reason: "reference_not_recorded",
      answerHash: job.record.answerHash,
    };
  }
  if (job.metadataOnly) {
    return {
      mode: "replace",
      status: "pending",
      reason: "resource_budget",
      answerHash: job.record.answerHash,
    };
  }
  try {
    if (link.localFile && path.isAbsolute(link.localFile)) {
      const root = await realpath(path.dirname(job.transcriptStorePath));
      const candidate = await realpath(link.localFile).catch(() => undefined);
      if (candidate) {
        const relative = path.relative(root, candidate);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          return await collectLegacyTranscript(job, candidate);
        }
      }
    }
    // Read legacy metadata directly without calling host helpers that now
    // materialize SQLite exports or mutate compatibility metadata.
    const store = await readSmallJson<Record<string, { sessionId?: string; sessionFile?: string }>>(
      job.transcriptStorePath,
      1024 * 1024,
    );
    if (store) {
      const entry = store[job.record.sessionKey];
      if (
        entry?.sessionId === link.sessionId &&
        entry.sessionFile &&
        !entry.sessionFile.startsWith("sqlite:")
      ) {
        const candidate = await scopedLegacyPath(job.transcriptStorePath, entry.sessionFile);
        if (!candidate) {
          return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
        }
        return await collectLegacyTranscript(job, candidate);
      }
      if (
        entry?.sessionFile &&
        !entry.sessionFile.startsWith("sqlite:") &&
        job.record.sessionKey === `agent:${job.record.agentId}:main` &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(link.sessionId)
      ) {
        // Exact saved SID after a reset, never the current session ID.
        const file = path.join(path.dirname(job.transcriptStorePath), `${link.sessionId}.jsonl`);
        const candidate = await scopedLegacyPath(job.transcriptStorePath, file);
        if (!candidate) {
          return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
        }
        return await collectLegacyTranscript(job, candidate);
      }
    }
    return await collectHostTranscript(job);
  } catch (error) {
    return {
      mode: "replace",
      status: "pending",
      reason:
        (error as Error).message === "metadata_size_limit" ? "resource_budget" : "read_failed",
    };
  }
}

/** New hosts expose generation-aware, bounded SQLite reads through the public SDK. */
export async function collectHostTranscript(job: FeedbackContentRequest): Promise<ReportContent> {
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return { mode: "replace", status: "missing", reason: "reference_not_recorded" };
  }
  const selected: unknown[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  let pageBudget = Math.min(64 * 1024, job.config.maxTranscriptBytes);
  try {
    for (let pages = 0; pages < 1024; pages++) {
      const page = await readHostTranscriptPage({
        agentId: job.record.agentId,
        sessionKey: job.record.sessionKey,
        sessionId: link.sessionId,
        storePath: job.transcriptStorePath,
        cursor,
        maxBytes: Math.min(pageBudget, job.config.maxTranscriptBytes - bytes),
        maxEvents: 128,
      });
      if (page.kind === "missing") {
        return { mode: "replace", status: "missing", reason: "transcript_not_found" };
      }
      if (page.kind === "reset") {
        return { mode: "replace", status: "pending", reason: "transcript_changed" };
      }
      bytes += page.serializedBytes;
      for (const row of page.events) {
        const event = row.event as { type?: string; id?: string } | null;
        if (
          event?.type === "session" ||
          event?.id === link.userMessageId ||
          event?.id === link.assistantMessageId
        ) {
          selected.push(event);
        }
      }
      if (selected.length > 3) {
        return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
      }
      if (!page.hasMore) {
        // Recheck the cursor's generation after the last page to reject rewrites.
        const check = await readHostTranscriptPage({
          agentId: job.record.agentId,
          sessionKey: job.record.sessionKey,
          sessionId: link.sessionId,
          storePath: job.transcriptStorePath,
          cursor: page.cursor,
          maxBytes: 1,
          maxEvents: 1,
        });
        if (check.kind !== "page" || check.hasMore) {
          return { mode: "replace", status: "pending", reason: "transcript_changed" };
        }
        return verifiedContent(job, selected);
      }
      if (bytes >= job.config.maxTranscriptBytes) {
        break;
      }
      if (page.requiredBytes) {
        if (page.requiredBytes > Math.min(1024 * 1024, job.config.maxTranscriptBytes - bytes)) {
          break;
        }
        pageBudget = page.requiredBytes;
      } else {
        if (cursor === page.cursor || !page.events.length) {
          break;
        }
        pageBudget = Math.min(64 * 1024, job.config.maxTranscriptBytes - bytes);
      }
      cursor = page.cursor;
    }
    return { mode: "replace", status: "pending", reason: "resource_budget" };
  } catch (error) {
    return {
      mode: "replace",
      status: "pending",
      reason:
        (error as Error).message === "bounded_reader_unavailable"
          ? "bounded_reader_unavailable"
          : "read_failed",
    };
  }
}
function verifiedContent(job: FeedbackContentRequest, events: unknown[]): ReportContent {
  const link = job.record.transcript;
  const result = resolveFeedbackTranscriptMessages(job.record, events);
  if (!result) {
    const ids = new Set(events.map((e) => (e as { id?: string }).id));
    const hasPair =
      link?.status === "linked" && ids.has(link.userMessageId) && ids.has(link.assistantMessageId);
    return {
      mode: "replace",
      status: hasPair ? "unverified" : "missing",
      reason: hasPair ? "content_verification_failed" : "message_not_found",
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > job.config.maxContentBytes) {
    return { mode: "replace", status: "pending", reason: "content_budget" };
  }
  return { mode: "replace", status: "available", ...result, answerHash: job.record.answerHash };
}

export async function collectLegacyTranscript(
  job: FeedbackContentRequest,
  file: string,
): Promise<ReportContent> {
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return { mode: "replace", status: "missing", reason: "reference_not_recorded" };
  }
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    return {
      mode: "replace",
      status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "pending",
      reason:
        (e as NodeJS.ErrnoException).code === "ENOENT" ? "transcript_not_found" : "read_failed",
    };
  }
  try {
    const initialStat = await handle.stat();
    if (initialStat.size > job.config.maxTranscriptBytes) {
      return { mode: "replace", status: "pending", reason: "resource_budget" };
    }
    const selected: unknown[] = [];
    let pending = Buffer.alloc(0);
    let total = 0;
    let header = false;
    let malformed = false;
    const consume = (line: Buffer) => {
      if (!line.length) {
        return;
      }
      try {
        const event = JSON.parse(line.toString("utf8"));
        if (event.type === "session") {
          header = true;
          selected.push(event);
        } else if (event.id === link.userMessageId || event.id === link.assistantMessageId) {
          selected.push(event);
        }
      } catch {
        malformed = true;
      }
    };
    for await (const chunk of handle.createReadStream({
      highWaterMark: 64 * 1024,
      autoClose: false,
    })) {
      total += chunk.length;
      if (total > job.config.maxTranscriptBytes) {
        return { mode: "replace", status: "pending", reason: "resource_budget" };
      }
      pending = Buffer.concat([pending, chunk]);
      let index;
      while ((index = pending.indexOf(10)) >= 0) {
        if (index > 1024 * 1024) {
          return { mode: "replace", status: "pending", reason: "resource_budget" };
        }
        consume(pending.subarray(0, index));
        pending = pending.subarray(index + 1);
      }
      if (pending.length > 1024 * 1024) {
        return { mode: "replace", status: "pending", reason: "resource_budget" };
      }
      if (selected.length > 4) {
        return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
      }
    }
    consume(pending);
    const finalStat = await handle.stat();
    if (initialStat.size !== finalStat.size || initialStat.mtimeMs !== finalStat.mtimeMs) {
      return { mode: "replace", status: "pending", reason: "transcript_changed" };
    }
    if (malformed || !header) {
      return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
    }
    return verifiedContent(job, selected);
  } finally {
    await handle.close();
  }
}
