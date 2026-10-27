import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHostTranscript } from "../../src/command/feedback-reporting-content";
import { readHostTranscriptPage } from "../../src/platform/session-transcript-reader";
import { reportingFixture } from "./fixtures/feedback-reporting";
vi.mock("../../src/platform/session-transcript-reader", () => ({
  readHostTranscriptPage: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const f = await reportingFixture();
  directories.push(f.dir);
  return f;
}
const page = (events: unknown[], cursor = "next", hasMore = false, bytes = 100) => ({
  kind: "page" as const,
  cursor,
  events: events.map((event, seq) => ({ event, seq })),
  hasMore,
  serializedBytes: bytes,
});
describe("generation-aware bounded transcript pages", () => {
  it("selects only the exact pair across multiple bounded pages", async () => {
    const f = await fixture();
    vi.mocked(readHostTranscriptPage)
      .mockResolvedValueOnce(page(f.events.slice(0, 2), "one", true))
      .mockResolvedValueOnce(page(f.events.slice(2), "two"))
      .mockResolvedValueOnce(page([], "two", false, 0));
    expect(await collectHostTranscript(f.job)).toMatchObject({
      status: "available",
      question: "Question",
      answer: "Answer",
    });
    expect(readHostTranscriptPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "one", maxEvents: 128 }),
    );
  });
  it("discards partial data when the transcript generation changes", async () => {
    const f = await fixture();
    vi.mocked(readHostTranscriptPage)
      .mockResolvedValueOnce(page(f.events.slice(0, 2), "old", true))
      .mockResolvedValueOnce({ kind: "reset", cursor: "new", reason: "generation_mismatch" });
    expect(await collectHostTranscript(f.job)).toEqual({
      mode: "replace",
      status: "pending",
      reason: "transcript_changed",
    });
  });
  it("does not send a pair if its generation changes during final verification", async () => {
    const f = await fixture();
    vi.mocked(readHostTranscriptPage)
      .mockResolvedValueOnce(page(f.events))
      .mockResolvedValueOnce({ kind: "reset", cursor: "new", reason: "generation_mismatch" });
    expect(await collectHostTranscript(f.job)).toMatchObject({
      status: "pending",
      reason: "transcript_changed",
    });
  });
  it("stops at the total read budget without advancing to an unrelated session", async () => {
    const f = await fixture();
    f.job.config.maxTranscriptBytes = 65536;
    vi.mocked(readHostTranscriptPage).mockResolvedValue(page([], "over", true, 65536));
    expect(await collectHostTranscript(f.job)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
    expect(readHostTranscriptPage).toHaveBeenCalledTimes(1);
  });
  it("bounds an individual oversized event before asking the host to load it", async () => {
    const f = await fixture();
    vi.mocked(readHostTranscriptPage).mockResolvedValue({
      ...page([], "same", true, 0),
      requiredBytes: 2 * 1024 * 1024,
    });
    expect(await collectHostTranscript(f.job)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
    expect(readHostTranscriptPage).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate IDs even across pages", async () => {
    const f = await fixture();
    vi.mocked(readHostTranscriptPage)
      .mockResolvedValueOnce(page(f.events, "one", true))
      .mockResolvedValueOnce(page([f.events[2]], "two"));
    expect(await collectHostTranscript(f.job)).toMatchObject({ status: "unverified" });
  });
});
