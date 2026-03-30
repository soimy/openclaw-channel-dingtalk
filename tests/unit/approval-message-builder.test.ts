import { describe, it, expect } from "vitest";
import {
  buildExecApprovalText,
  buildPluginApprovalText,
} from "../../src/approval-message-builder";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";

const NOW_MS = 1000000000000;

function makeExecRequest(overrides: Partial<ExecApprovalRequest["request"]> = {}): ExecApprovalRequest {
  return {
    id: "exec-id-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 120_000,
    request: {
      command: "trash ~/Downloads/file.csv",
      cwd: "/Users/wangbin/workspace",
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
      ...overrides,
    },
  };
}

function makePluginRequest(overrides: Partial<PluginApprovalRequest["request"]> = {}): PluginApprovalRequest {
  return {
    id: "plugin-id-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 120_000,
    request: {
      title: "Sage: tool",
      description: "Severity: warning\nReason: Overly permissive file permissions",
      severity: "warning",
      toolName: "exec",
      pluginId: "sage-openclaw",
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
      ...overrides,
    },
  };
}

describe("buildExecApprovalText", () => {
  it("包含命令、目录、Agent 和过期时间", () => {
    const text = buildExecApprovalText(makeExecRequest(), NOW_MS);
    expect(text).toContain("🔒");
    expect(text).toContain("trash ~/Downloads/file.csv");
    expect(text).toContain("/Users/wangbin/workspace");
    expect(text).toContain("main");
    expect(text).toContain("120");
  });

  it("cwd 为 null 时不渲染目录行", () => {
    const text = buildExecApprovalText(makeExecRequest({ cwd: null }), NOW_MS);
    expect(text).not.toContain("目录");
  });

  it("agentId 为 null 时不渲染 Agent 行", () => {
    const text = buildExecApprovalText(makeExecRequest({ agentId: null }), NOW_MS);
    expect(text).not.toContain("Agent");
  });

  it("包含 /approve 使用说明", () => {
    const text = buildExecApprovalText(makeExecRequest(), NOW_MS);
    expect(text).toContain("/approve");
    expect(text).toContain("allow-once");
    expect(text).toContain("deny");
  });

  it("过期时间为 0 时显示 0 秒", () => {
    const req = makeExecRequest();
    const text = buildExecApprovalText(req, req.expiresAtMs + 5000);
    expect(text).toContain("0秒");
  });
});

describe("buildPluginApprovalText", () => {
  it("包含标题、描述、工具名、Plugin 和过期时间", () => {
    const text = buildPluginApprovalText(makePluginRequest(), NOW_MS);
    expect(text).toContain("Sage: tool");
    expect(text).toContain("Overly permissive file permissions");
    expect(text).toContain("exec");
    expect(text).toContain("sage-openclaw");
    expect(text).toContain("120");
  });

  it("warning severity 使用 ⚠️", () => {
    const text = buildPluginApprovalText(makePluginRequest({ severity: "warning" }), NOW_MS);
    expect(text).toContain("⚠️");
  });

  it("critical severity 使用 🚨", () => {
    const text = buildPluginApprovalText(makePluginRequest({ severity: "critical" }), NOW_MS);
    expect(text).toContain("🚨");
  });

  it("toolName 为 null 时不渲染工具行", () => {
    const text = buildPluginApprovalText(makePluginRequest({ toolName: null }), NOW_MS);
    expect(text).not.toContain("工具:");
  });

  it("包含 /approve 使用说明", () => {
    const text = buildPluginApprovalText(makePluginRequest(), NOW_MS);
    expect(text).toContain("/approve");
    expect(text).toContain("allow-once");
    expect(text).toContain("deny");
  });
});
