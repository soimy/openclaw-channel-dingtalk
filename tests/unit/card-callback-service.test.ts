import { describe, expect, it } from "vitest";
import { analyzeCardCallback, extractCardActionId } from "../../src/card-callback-service";

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

  it("parses feedback callbacks with feedback target fields", () => {
    const analysis = analyzeCardCallback({
      actionValue: "feedback_up",
      spaceType: "im",
      userId: "user_1",
      processQueryKey: "pq_1",
    });

    expect(analysis.actionId).toBe("feedback_up");
    expect(analysis.feedbackTarget).toBe("user_1");
    expect(analysis.feedbackAckText).toContain("点赞");
    expect(analysis.processQueryKey).toBe("pq_1");
  });

  it("parses stop callbacks with outTrackId and user fields", () => {
    const analysis = analyzeCardCallback({
      outTrackId: "track_1",
      cardInstanceId: "card_1",
      userId: "user_2",
      spaceId: "space_2",
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ["btn_stop"],
        },
      }),
    });

    expect(analysis.actionId).toBe("btn_stop");
    expect(analysis.outTrackId).toBe("track_1");
    expect(analysis.cardInstanceId).toBe("card_1");
    expect(analysis.userId).toBe("user_2");
    expect(analysis.spaceId).toBe("space_2");
  });

  it("extracts cardPrivateData with params from sendCardRequest approval callback", () => {
    const result = analyzeCardCallback({
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ["approval0"],
          params: { t: "approval", d: "allow-once", id: "exec:123" },
        },
      }),
    });
    expect(result.cardPrivateData).toEqual({
      actionIds: ["approval0"],
      params: { t: "approval", d: "allow-once", id: "exec:123" },
    });
    expect(result.actionId).toBe("approval0");
  });
});
