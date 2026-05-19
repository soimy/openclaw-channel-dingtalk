import { beforeEach, describe, expect, it, vi } from "vitest";
import { findActiveAgentCard } from "../../src/approval/approval-card-locator";

vi.mock("../../src/card/card-run-registry", () => ({
  resolveActiveCardRunBySession: vi.fn(),
}));

const { resolveActiveCardRunBySession } = await import("../../src/card/card-run-registry");
const mockResolveActiveCardRunBySession = vi.mocked(resolveActiveCardRunBySession);

describe("approval-card-locator", () => {
  beforeEach(() => mockResolveActiveCardRunBySession.mockReset());

  it("returns outTrackId and sessionKey when the registry finds an active record", () => {
    mockResolveActiveCardRunBySession.mockReturnValue({
      outTrackId: "ai_card_xxx",
      sessionKey: "session-A",
    } as never);

    expect(
      findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "session-A" }),
    ).toEqual({ outTrackId: "ai_card_xxx", sessionKey: "session-A" });
  });

  it("returns null when the registry misses", () => {
    mockResolveActiveCardRunBySession.mockReturnValue(null);

    expect(
      findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "session-A" }),
    ).toBeNull();
  });

  it("returns null without querying the registry when sessionKey is empty", () => {
    expect(findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "" })).toBe(
      null,
    );
    expect(mockResolveActiveCardRunBySession).not.toHaveBeenCalled();
  });

  it("passes accountId through to the registry", () => {
    mockResolveActiveCardRunBySession.mockReturnValue(null);

    findActiveAgentCard({ cfg: {} as never, accountId: "acme", sessionKey: "session-A" });

    expect(mockResolveActiveCardRunBySession).toHaveBeenCalledWith("acme", "session-A");
  });
});
