import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const template = JSON.parse(
  readFileSync(new URL("../../docs/assets/card-template-v2.json", import.meta.url), "utf8"),
);
const editor = JSON.parse(template.editorData);
function feedbackNodes(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.flatMap(feedbackNodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, any>;
  return [
    ...(node.componentName === "Feedback" && node.id ? [node] : []),
    ...Object.values(node).flatMap(feedbackNodes),
  ];
}
describe("published feedback template contract", () => {
  it("enables one native feedback component and its business callback", () => {
    const nodes = feedbackNodes(editor.schema.componentsTree);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].props).toMatchObject({
      enableLikeDislike: true,
      visible: { value: true },
      actionId: { content: "feedback_vote" },
    });
  });
  it("ships compiled runtime callbacks as well as editor settings", () => {
    expect(template.widgetInfo).toContain("feedback_vote");
    expect(template.widgetInfo).not.toContain("sys_action_like_component");
    expect(template.widgetInfo).toContain("node_ocmncu094ga_likeOrDislike");
    expect(template.widgetInfo).toContain("node_ocmncu094ga_dislikeTags");
  });
  it("retains the original streaming and final-answer variable contract", () => {
    for (const variable of [
      "flowStatus",
      "content",
      "blockList",
      "hasAction",
      "statusLine",
      "copy_content",
      "quoteContent",
    ]) {
      expect(template.widgetInfo).toContain(variable);
    }
  });
});
