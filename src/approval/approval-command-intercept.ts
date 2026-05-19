import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getConfig } from "../config";
import { sendProactiveTextOrMarkdown } from "../send-service";
import type { Logger } from "../types";
import { parseApproveCommand } from "./approval-command-parser";
import { resolveApproval } from "./approval-resolver";

export interface ApproveCommandInterceptInput {
  cfg: OpenClawConfig;
  accountId: string;
  text: string;
  senderId: string;
  log?: Logger;
}

const APPROVE_COMMAND_RE = /^\/?approve(?:\s|$)/i;

async function sendDirectHint(
  input: Pick<ApproveCommandInterceptInput, "cfg" | "accountId" | "senderId" | "log">,
  text: string,
): Promise<void> {
  try {
    await sendProactiveTextOrMarkdown(
      getConfig(input.cfg, input.accountId),
      `user:${input.senderId}`,
      text,
      { accountId: input.accountId, forceMarkdown: true, log: input.log },
    );
  } catch (error) {
    input.log?.warn?.(
      `[DingTalk][Approval] failed to send /approve hint sender=${input.senderId} err=${String(
        (error as Error | null)?.message ?? error,
      )}`,
    );
  }
}

export async function tryInterceptApproveCommand(
  input: ApproveCommandInterceptInput,
): Promise<boolean> {
  const trimmed = input.text.trim();
  if (!APPROVE_COMMAND_RE.test(trimmed)) {
    return false;
  }

  const parsed = parseApproveCommand(trimmed);
  if (!parsed) {
    await sendDirectHint(
      input,
      "⚠️ /approve 命令格式错误。用法：`/approve <approvalId> <allow-once|allow-always|deny>`",
    );
    input.log?.warn?.("[DingTalk][Approval] malformed /approve command");
    return true;
  }

  const result = await resolveApproval({
    cfg: input.cfg,
    accountId: input.accountId,
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    senderId: input.senderId,
    log: input.log,
  });

  if (result.ok) {
    input.log?.info?.(
      `[DingTalk][Approval] /approve resolved approvalId=${parsed.approvalId} decision=${parsed.decision}`,
    );
    return true;
  }

  if (result.reason === "unauthorized") {
    await sendDirectHint(input, `⛔ 你不在 approver 名单，无权批准此请求（${parsed.approvalId}）。`);
  } else if (result.reason === "invalid-decision") {
    const hint = result.allowedDecisions?.length
      ? `请选择：${result.allowedDecisions.join(" / ")}`
      : "请选择允许一次或拒绝";
    await sendDirectHint(
      input,
      `ℹ️ 该审批不支持 ${parsed.decision}。${hint}（${parsed.approvalId}）。`,
    );
  } else if (result.reason === "not-found" || result.reason === "already-resolved") {
    await sendDirectHint(input, `ℹ️ 审批 ${parsed.approvalId} 已处理或已过期，无需再次操作。`);
  } else if (result.reason === "gateway-error") {
    await sendDirectHint(input, `ℹ️ 审批 ${parsed.approvalId} 暂时处理失败，请稍后重试。`);
  }

  input.log?.info?.(`[DingTalk][Approval] /approve resolver returned ${result.reason}`);
  return true;
}
