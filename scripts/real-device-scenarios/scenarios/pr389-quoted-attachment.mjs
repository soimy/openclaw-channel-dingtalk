export default {
    id: "pr389-quoted-attachment",
    title: "PR389 quoted attachment excerpt",
    goal: "验证 quoted attachment excerpt 能进入 ReplyToBody",
    channel: "dingtalk",
    tags: ["quoted", "attachment", "reply-to-body", "dingtalk-dm"],
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
                id: "quoted_attachment",
                kind: "file",
                filePath: ".local/manual-test/pr389-quoted-attachment.txt",
                contentHint: "PR389-ATTACHMENT-SEED",
            },
        ],
    },
    steps: [
        {
            id: "send_fixture",
            actor: "operator",
            kind: "send_fixture",
            sourceRef: "quoted_attachment",
        },
        {
            id: "quote_fixture",
            actor: "operator",
            kind: "quote_message",
            sourceRef: "quoted_attachment",
            message: "{{traceToken}} 请只复述被引用文件的第一行，不要输出占位文案。",
        },
    ],
    expected: {
        replyVisible: true,
        replyShouldContain: ["PR389-ATTACHMENT-SEED"],
        replyShouldNotContain: ["[Quoted file]", "[钉钉文档]"],
        logSignals: ["quotedRef hit=yes", "fileName=pr389-quoted-attachment.txt"],
    },
    cleanup: {
        restoreBackups: true,
    },
};
