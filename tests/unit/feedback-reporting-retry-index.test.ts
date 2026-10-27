import { describe, expect, it } from "vitest";
import {
  FeedbackRetryIndex,
  FEEDBACK_RETRY_INDEX_LIMIT,
} from "../../src/command/feedback-reporting-retry-index";

describe("bounded feedback retry hints", () => {
  it("waits for deadlines and admits the earliest first", () => {
    const index = new FeedbackRetryIndex<{ due: number; id: string }>();
    index.set("later", { due: 30, id: "later" });
    index.set("first", { due: 10, id: "first" });
    expect(index.takeDue(9)).toBeUndefined();
    expect(index.nextDue()).toBe(10);
    expect(index.takeDue(10)?.id).toBe("first");
    expect(index.takeDue(30)?.id).toBe("later");
    expect(index.nextDue()).toBeUndefined();
  });

  it("keeps only the earliest bounded hints and returns evictions for durable recovery", () => {
    const index = new FeedbackRetryIndex<{ due: number; id: string }>();
    for (let i = 0; i < FEEDBACK_RETRY_INDEX_LIMIT; i++)
      expect(index.set(String(i), { due: i + 100, id: String(i) })).toBeUndefined();
    expect(index.set("overflow", { due: 10000, id: "overflow" })?.id).toBe("overflow");
    expect(index.set("urgent", { due: 1, id: "urgent" })?.id).toBe(
      String(FEEDBACK_RETRY_INDEX_LIMIT - 1),
    );
    expect(index.size).toBe(FEEDBACK_RETRY_INDEX_LIMIT);
    expect(index.takeDue(1)?.id).toBe("urgent");
    expect(index.size).toBe(FEEDBACK_RETRY_INDEX_LIMIT - 1);
  });

  it("replaces repeated hints without growing the index or retaining obsolete deadlines", () => {
    const index = new FeedbackRetryIndex<{ due: number; revision: number }>(2);
    index.set("a", { due: 20, revision: 1 });
    index.set("b", { due: 30, revision: 1 });
    for (let i = 2; i <= 10000; i++) index.set("a", { due: 40, revision: i });
    expect(index.size).toBe(2);
    expect(index.nextDue()).toBe(30);
    index.delete("b");
    expect(index.takeDue(39)).toBeUndefined();
    expect(index.takeDue(40)?.revision).toBe(10000);
    index.set("a", { due: 10, revision: 10001 });
    index.clear();
    expect(index.size).toBe(0);
    expect(index.get("a")).toBeUndefined();
    expect(index.nextDue()).toBeUndefined();
  });
});
