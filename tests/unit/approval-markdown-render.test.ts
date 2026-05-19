import { describe, expect, it } from "vitest";
import {
  buildExecApprovalMarkdown,
  buildPluginApprovalMarkdown,
} from "../../src/approval/approval-markdown-render";

const NOW = Date.parse("2026-05-19T10:00:00Z");

function execRequest(payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: "abc123",
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + 10 * 60_000,
    request: {
      command: 'docker image prune -a -f --filter "until=720h"',
      cwd: "/Users/zhumin/projects/openclaw",
      ...payload,
    },
    ...overrides,
  } as never;
}

function pluginRequest(payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin:xyz789",
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + 10 * 60_000,
    request: {
      title: "数据库查询",
      toolName: "query_database",
      description: "对 production.orders 表查询近 7 天订单",
      ...payload,
    },
    ...overrides,
  } as never;
}

describe("approval-markdown-render", () => {
  it("renders exec id, command preview, cwd, expiry, and all default decisions", () => {
    const markdown = buildExecApprovalMarkdown(execRequest(), NOW);

    expect(markdown).toContain("abc123");
    expect(markdown).toMatch(/```[\s\S]*docker image prune/);
    expect(markdown).toContain("/approve abc123 allow-once");
    expect(markdown).toContain("/approve abc123 allow-always");
    expect(markdown).toContain("/approve abc123 deny");
    expect(markdown).toMatch(/10\s*分钟/);
  });

  it("uses upstream exec decision filtering", () => {
    const markdown = buildExecApprovalMarkdown(execRequest({ allowedDecisions: ["deny"] }), NOW);

    expect(markdown).toContain("/approve abc123 deny");
    expect(markdown).not.toContain("/approve abc123 allow-once");
    expect(markdown).not.toContain("/approve abc123 allow-always");
  });

  it("does not render allow-always for ask=always exec requests", () => {
    const markdown = buildExecApprovalMarkdown(execRequest({ ask: "always" }), NOW);

    expect(markdown).toContain("/approve abc123 allow-once");
    expect(markdown).toContain("/approve abc123 deny");
    expect(markdown).not.toContain("/approve abc123 allow-always");
  });

  it("renders plugin id, tool, description, and decisions", () => {
    const markdown = buildPluginApprovalMarkdown(pluginRequest(), NOW);

    expect(markdown).toContain("plugin:xyz789");
    expect(markdown).toContain("query_database");
    expect(markdown).toContain("production.orders");
    expect(markdown).toContain("/approve plugin:xyz789 allow-once");
    expect(markdown).toContain("/approve plugin:xyz789 allow-always");
    expect(markdown).toContain("/approve plugin:xyz789 deny");
  });

  it("filters plugin decisions locally to match upstream semantics", () => {
    const markdown = buildPluginApprovalMarkdown(
      pluginRequest({ allowedDecisions: ["allow-once"] }),
      NOW,
    );

    expect(markdown).toContain("/approve plugin:xyz789 allow-once");
    expect(markdown).not.toContain("/approve plugin:xyz789 allow-always");
    expect(markdown).not.toContain("/approve plugin:xyz789 deny");
  });

  it("omits expired negative minute hints", () => {
    expect(buildPluginApprovalMarkdown(pluginRequest({}, { expiresAtMs: NOW - 1000 }), NOW)).not.toMatch(
      /-?\d+\s*分钟/,
    );
  });
});
