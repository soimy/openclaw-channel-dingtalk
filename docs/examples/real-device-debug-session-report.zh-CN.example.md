# 真机调试记录模板

- Session ID: `dtdbg-YYYYMMDD-HHMMSS-<scenario>`
- Trace Token: `DTDBG-YYYYMMDD-HHMMSS-XXXX`
- 测试场景：`dm-text-reply`
- 测试目标：`conversationId=<...>`
- 操作端：`人工 / Peekaboo 类 agent`
- 运行命令：
  - `pnpm debug:session run --scenario dm-text-reply --target-id <conversationId> --target-label "Debug Chat" --no-stream-monitor`
  - `pnpm debug:session observe --session-dir <sessionDir> --observation-file <observation.json>`
  - `pnpm debug:session judge --session-dir <sessionDir>`

## 结果摘要

- 最终 outcome：`end_to_end_success / success_high_latency / inbound_without_outbound / outbound_not_visible_in_client / no_inbound_evidence`
- 钉钉客户端是否可见：`是 / 否`
- 首次回复可见耗时：`<ms 或秒>`
- 关键备注：`<一句话总结>`

## 证据

- `manifest.json`
- `judgment.json`
- `summary.md`
- `screenshots/<file>.png`

## 附加说明

- 如果是“客户端不可见”，请说明消息是否确认发出，以及超时窗口多长
- 如果是“没有 inbound 证据”，请说明该 probe message 是否确认已在钉钉中发送成功
- 如果是“高延迟成功”，请补充当时网络环境、租户、是否启用 AI Card 等上下文
