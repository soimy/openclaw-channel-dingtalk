function buildFixtureLines(scenario) {
    const fixtures = scenario.fixtures?.seedMessages ?? [];
    if (fixtures.length === 0) {
        return "";
    }
    return fixtures
        .map((entry) => {
            if (entry.kind === "file") {
                return `- fixture \`${entry.id}\`: send file \`${entry.filePath}\``;
            }
            return `- fixture \`${entry.id}\`: send text \`${entry.content}\``;
        })
        .join("\n");
}

function buildStepLines(scenario) {
    return scenario.steps
        .map((step, index) => {
            if (step.kind === "send_message") {
                return `${index + 1}. 发送消息：\`${step.message}\``;
            }
            if (step.kind === "send_fixture") {
                return `${index + 1}. 发送 fixture：\`${step.sourceRef}\``;
            }
            if (step.kind === "quote_message") {
                return `${index + 1}. 引用 \`${step.sourceRef}\` 后发送：\`${step.message}\``;
            }
            return `${index + 1}. 等待 harness 执行步骤：\`${step.kind}\``;
        })
        .join("\n");
}

export function renderResolveTargetPrompt({ manifest, scenario }) {
    return `# Resolve Target

你现在需要帮助 harness 确认本次真机测试的目标会话。

- Scenario: \`${scenario.title}\`
- Session ID: \`${manifest.sessionId}\`
- Trace Token: \`${manifest.traceToken}\`
- Channel: \`${scenario.channel}\`
- Target mode: \`${scenario.target.mode}\`

请确认当前钉钉测试会话的最小上下文，并回填到 \`resolve-target.response.json\`。
`;
}

export function renderResolveTargetInput({ manifest, scenario }) {
    return {
        phase: "resolve_target",
        scenarioId: scenario.id,
        sessionId: manifest.sessionId,
        traceToken: manifest.traceToken,
        channel: scenario.channel,
        mode: scenario.target.mode,
        resolver: scenario.target.resolver,
        requiredFields:
            scenario.target.mode === "dm" ? ["conversationId", "senderStaffId"] : ["conversationId"],
    };
}

export function renderResolveTargetResponseTemplate({ scenario }) {
    return {
        status: "completed",
        channel: scenario.channel,
        mode: scenario.target.mode,
        conversationId: "",
        senderStaffId: "",
        displayName: "",
        notes: "",
    };
}

export function renderOperatorPrompt({ manifest, scenario }) {
    const fixtureLines = buildFixtureLines(scenario);
    const stepLines = buildStepLines(scenario);

    return `# Operator Action

本次测试目标：
\`${scenario.title}\`

目标说明：
\`${scenario.goal}\`

- Session ID: \`${manifest.sessionId}\`
- Trace Token: \`${manifest.traceToken}\`
- Target: \`${manifest.target.label || manifest.target.id}\`

${fixtureLines ? `Fixtures:\n${fixtureLines}\n` : ""}请按顺序执行：

${stepLines}

注意：
- 将消息中的 \`{{traceToken}}\` 替换为实际 trace token：\`${manifest.traceToken}\`
- 每完成一个 operator 步骤后，将完成结果写入 \`operator-response.json\`
- 当最后一步完成并且你已经看到了客户端回复，再把结果写入 \`observation.json\`
`;
}

export function renderOperatorInput({ manifest, scenario }) {
    return {
        phase: "operator_action",
        scenarioId: scenario.id,
        sessionId: manifest.sessionId,
        traceToken: manifest.traceToken,
        target: {
            id: manifest.target.id,
            label: manifest.target.label,
            mode: scenario.target.mode,
        },
        steps: scenario.steps.map((step) => ({
            id: step.id,
            actor: step.actor,
            kind: step.kind,
            message: step.message,
            sourceRef: step.sourceRef,
        })),
    };
}

export function renderOperatorResponseTemplate() {
    return {
        status: "completed",
        completedStepId: "",
        notes: "",
    };
}

export function renderObservationTemplate() {
    return {
        status: "completed",
        sentAt: "",
        replyObservedAt: "",
        sendStatus: "sent",
        replyStatus: "visible",
        replyPreview: "",
        notes: "",
        screenshots: [],
    };
}
