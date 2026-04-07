import { describe, expect, it } from "vitest";
import { buildBtwBlockquote } from "../../src/messaging/btw-deliver";

describe("buildBtwBlockquote", () => {
  it("formats a normal /btw question with sender prefix", () => {
    const result = buildBtwBlockquote("王滨", "/btw 这个函数为什么慢");
    expect(result).toBe("> 王滨: /btw 这个函数为什么慢\n\n");
  });
});
