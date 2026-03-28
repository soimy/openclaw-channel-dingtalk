export default {
    id: "pr389-preview-store-miss",
    title: "PR389 store miss preview fallback",
    goal: "验证 first-hop record miss 时，事件 preview 仍能进入 ReplyToBody",
    channel: "dingtalk",
    tags: ["quoted", "preview", "store-miss", "dingtalk-dm"],
    target: {
        mode: "dm",
        resolver: "latest_inbound_sender",
    },
    setup: {
        createSession: true,
        restartGateway: true,
        startLogs: true,
        streamMonitor: false,
    },
    fixtures: {
        seedMessages: [
            {
                id: "seed_message",
                kind: "text",
                content: "PR389-PREVIEW-STOREMISS-SEED 第一跳 preview 应该在 store miss 时仍可进入 ReplyToBody。",
            },
        ],
    },
    steps: [
        {
            id: "send_seed",
            actor: "operator",
            kind: "send_message",
            message: "PR389-PREVIEW-STOREMISS-SEED 第一跳 preview 应该在 store miss 时仍可进入 ReplyToBody。",
        },
        {
            id: "delete_record",
            actor: "harness",
            kind: "delete_message_context_record",
            sourceRef: "seed_message",
        },
        {
            id: "quote_seed",
            actor: "operator",
            kind: "quote_message",
            sourceRef: "seed_message",
            message: "{{traceToken}} 现在假设 store miss，请只复述被引用消息的开头一句，不要解释。",
        },
    ],
    expected: {
        replyVisible: true,
        replyShouldContain: ["PR389-PREVIEW-STOREMISS-SEED"],
        replyShouldNotContain: ["[Quoted file]", "[Quoted interactiveCardFile]"],
        logSignals: ["quotedRef hit=no", "previewText=PR389-PREVIEW-STOREMISS-SEED"],
    },
    cleanup: {
        restoreBackups: true,
    },
};
