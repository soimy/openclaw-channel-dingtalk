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
});
