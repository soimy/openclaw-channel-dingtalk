import { describe, expect, it } from "vitest";
import {
  analyzeCardCallback,
  extractCardActionId,
  extractCardActionParams,
  formatCardActionMessage,
} from "../../src/card-callback-service";

describe("card-callback-service", () => {
  it("extracts action id from embedded value payload", () => {
    expect(
      extractCardActionId({
        value: JSON.stringify({ cardPrivateData: { actionIds: ["feedback_up"] } }),
      }),
    ).toBe("feedback_up");
  });

  it("resolves direct-message feedback callback target and ack text", () => {
    expect(
      analyzeCardCallback({
        value: JSON.stringify({ cardPrivateData: { actionIds: ["feedback_down"] } }),
        spaceType: "IM",
        userId: "user_123",
      }),
    ).toMatchObject({
      actionId: "feedback_down",
      feedbackTarget: "user_123",
      feedbackAckText: "⚠️ 已收到你的点踩（反馈已记录，我会改进）",
    });
  });

  it("extracts processQueryKey from embedded callback payload", () => {
    expect(
      analyzeCardCallback({
        value: JSON.stringify({
          processQueryKey: "pqk_123",
          cardPrivateData: { actionIds: ["feedback_up"] },
        }),
        spaceType: "IM",
        userId: "user_123",
      }),
    ).toMatchObject({
      actionId: "feedback_up",
      processQueryKey: "pqk_123",
      feedbackTarget: "user_123",
    });
  });

  describe("extractCardActionParams", () => {
    it("extracts params from cardPrivateData in embedded value", () => {
      const result = extractCardActionParams({
        value: JSON.stringify({
          cardPrivateData: {
            actionIds: ["btn_run"],
            params: { "运行吗": "运行SQL" },
          },
        }),
      });
      expect(result).toEqual({ "运行吗": "运行SQL" });
    });

    it("extracts params from top-level cardPrivateData", () => {
      const result = extractCardActionParams({
        cardPrivateData: {
          actionIds: ["btn_1"],
          params: { action: "confirm", count: 42 },
        },
      });
      expect(result).toEqual({ action: "confirm", count: 42 });
    });

    it("returns undefined when no params present", () => {
      expect(extractCardActionParams({
        value: JSON.stringify({ cardPrivateData: { actionIds: ["btn_1"] } }),
      })).toBeUndefined();
    });

    it("returns undefined when params is empty object", () => {
      expect(extractCardActionParams({
        cardPrivateData: { actionIds: ["btn_1"], params: {} },
      })).toBeUndefined();
    });

    it("returns undefined for feedback callbacks", () => {
      expect(extractCardActionParams({
        value: JSON.stringify({
          cardPrivateData: { actionIds: ["feedback_up"], params: { foo: "bar" } },
        }),
      })).toBeUndefined();
    });
  });

  describe("formatCardActionMessage", () => {
    it("formats params as [Card Action Callback] block", () => {
      const result = formatCardActionMessage({ "运行吗": "运行SQL" });
      expect(result).toBe("[Card Action Callback]\n运行吗: 运行SQL");
    });

    it("formats multiple params with one per line", () => {
      const result = formatCardActionMessage({ action: "confirm", target: "db1" });
      expect(result).toBe("[Card Action Callback]\naction: confirm\ntarget: db1");
    });

    it("stringifies non-string values", () => {
      const result = formatCardActionMessage({ count: 42, nested: { a: 1 } });
      expect(result).toBe("[Card Action Callback]\ncount: 42\nnested: {\"a\":1}");
    });
  });

  it("analyzeCardCallback populates params for non-feedback actions", () => {
    const analysis = analyzeCardCallback({
      value: JSON.stringify({
        cardPrivateData: {
          actionIds: ["btn_run"],
          params: { "运行吗": "运行SQL" },
        },
      }),
      spaceType: "IM",
      userId: "user_456",
      spaceId: "space_789",
    });
    expect(analysis.params).toEqual({ "运行吗": "运行SQL" });
    expect(analysis.feedbackTarget).toBeUndefined();
  });
});
