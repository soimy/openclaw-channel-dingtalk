import { describe, expect, it, vi } from "vitest";
import {
  analyzeCardCallback,
  extractCardActionId,
  extractCardActionParams,
  formatCardActionMessage,
  updateCardVariables,
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
            params: { status: "approved" },
          },
        }),
      });
      expect(result).toEqual({ status: "approved" });
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
      const result = formatCardActionMessage({ status: "approved" });
      expect(result).toBe("[Card Action Callback]\nstatus: approved");
    });

    it("formats multiple params with one per line", () => {
      const result = formatCardActionMessage({ action: "confirm", target: "db1" });
      expect(result).toBe("[Card Action Callback]\naction: confirm\ntarget: db1");
    });

    it("stringifies non-string values", () => {
      const result = formatCardActionMessage({ count: 42, nested: { a: 1 } });
      expect(result).toBe("[Card Action Callback]\ncount: 42\nnested: {\"a\":1}");
    });

    it("includes outTrackId when provided", () => {
      const result = formatCardActionMessage({ status: "approved" }, "card-1773752494405");
      expect(result).toBe("[Card Action Callback]\noutTrackId: card-1773752494405\nstatus: approved");
    });

    it("omits outTrackId when not provided", () => {
      const result = formatCardActionMessage({ action: "confirm" });
      expect(result).toBe("[Card Action Callback]\naction: confirm");
    });
  });

  describe("updateCardVariables", () => {
    it("sends PUT request with stringified params", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200 } as Response);
      const status = await updateCardVariables("card-123", { status: "approved", count: 42 }, "test-token");
      expect(status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.dingtalk.com/v1.0/card/instances");
      expect(options!.method).toBe("PUT");
      expect((options!.headers as Record<string, string>)["x-acs-dingtalk-access-token"]).toBe("test-token");
      const body = JSON.parse(options!.body as string);
      expect(body.outTrackId).toBe("card-123");
      expect(body.cardData.cardParamMap).toEqual({ status: "approved", count: "42" });
      expect(body.cardUpdateOptions.updateCardDataByKey).toBe(true);
      fetchSpy.mockRestore();
    });
  });

  it("analyzeCardCallback populates params and outTrackId for non-feedback actions", () => {
    const analysis = analyzeCardCallback({
      value: JSON.stringify({
        cardPrivateData: {
          actionIds: ["btn_run"],
          params: { status: "approved" },
        },
      }),
      outTrackId: "card-12345",
      spaceType: "IM",
      userId: "user_456",
      spaceId: "space_789",
    });
    expect(analysis.params).toEqual({ status: "approved" });
    expect(analysis.outTrackId).toBe("card-12345");
    expect(analysis.feedbackTarget).toBeUndefined();
  });
});
