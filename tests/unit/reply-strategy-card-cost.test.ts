import { afterEach, beforeEach, expect, it } from "vitest";
import { accumulateUsage } from "../../src/card/run-usage-store";
import {
  commitAICardBlocksMock,
  makeCard,
  buildCtx,
  beforeEachReplyStrategyCard,
  afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";


beforeEach(beforeEachReplyStrategyCard);
afterEach(afterEachReplyStrategyCard);

it("places cost in the card status line without changing reply text", async () => {
  const ctx = buildCtx(makeCard(), {
    config: {
      clientId: "id",
      clientSecret: "secret",
      messageType: "card",
      cardStatusLine: { cost: true },
    },
    taskMeta: { model: "test-model" },
  });
  const strategy = createCardReplyStrategy(ctx);
  strategy.getReplyOptions().onAgentRunStart?.("priced-run");
  accumulateUsage("priced-run", { input: 1000, output: 100, cost: { total: 0.003 } });
  await strategy.deliver({ text: "Hello", mediaUrls: [], kind: "final" });
  await strategy.finalize();
  expect(commitAICardBlocksMock).toHaveBeenCalled();
  const options = commitAICardBlocksMock.mock.calls[0][1];
  expect(options.statusLine).toContain("~$0.0030");
  expect(options.content).toBe("Hello");
});
