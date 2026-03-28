# 提案：钉钉 AI 卡片性能元数据展示 (Metadata Display)

## 1. 背景与目标
为了提升用户体验，增加回复的可解释性，建议在钉钉 AI 流式卡片中增加以下性能元数据展示：
- **模型信息 (Model)**: 明确当前是由哪个模型（如 `gpt-5.4` 或 `gemini-3-flash`）生成的回复。
- **智能体信息 (Agent)**: 区分是哪个 Agent 实例（如 `main` 或子智能体）。
- **耗时统计 (Time)**: 统计从接收用户消息到最终完成回复的总用时（单位：秒）。

## 2. 预计成果 (UI Mockup)
在卡片回复正文的最下方，或思考区下方，显示一行精致的元数据条：

> 🤖 **Agent**: `main`  |  🧠 **Model**: `pro` (gpt-5.4)  |  ⏱️ **Time**: `3.2s`

## 3. 详细实现路径

### 3.1 耗时追踪 (Timing)
- **起点**：在 `src/inbound-handler.ts` 的 `processInbound` 开始处记录 `const startTime = Date.now();`。
- **透传**：将 `startTime` 通过 `options` 透传至 `src/send-service.ts`。
- **终点**：在发送 `finished: true` 的流式更新包之前，计算 `duration = (Date.now() - startTime) / 1000`。

### 3.2 信息拼装
- 在 `src/send-service.ts` 的 `sendMessage` 方法中，判断是否开启了 `card` 模式。
- 如果是，在最终文本（`text`）末尾追加 Markdown 格式的元数据行。

### 3.3 代码层级修改点
1. **`src/types.ts`**:
   - 在 `SendMessageOptions` 接口中添加 `startTime?: number`。
2. **`src/inbound-handler.ts`**:
   - 在接收到用户消息的第一时间（`onInbound` 触发时）记录时间戳。
3. **`src/send-service.ts`**:
   - 在 `sendMessage` 逻辑中，计算耗时并组装文本。
   - 确保仅在 `finalize`（结束）时追加该信息，避免流式过程中底部内容跳动。

## 4. 潜在风险与优化
- **Markdown 兼容性**：钉钉卡片内部的 Markdown 解析能力略弱于标准 Markdown，需确保使用的 Emoji 和粗体语法在所有客户端版本（PC/Mobile）都能对齐。
- **自动降级兜底**：如果 AI 卡片因故降级为普通 Markdown 消息发送，同样可以保留该元数据行。

---
**版本**: v1.0
**日期**: 2026-03-14
