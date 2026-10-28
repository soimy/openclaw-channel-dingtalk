import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import type { HandleDingTalkMessageParams } from "../../src/platform/types";
// Register the existing network/card mocks before loading the real inbound pipeline.
import {
  shared,
  buildRuntime,
  beforeEachInboundHandlerCard,
  mockedUpsertInboundMessageContext,
} from "./fixtures/inbound-handler-card";
import { handleDingTalkMessage } from "../../src/gateway/inbound-handler";
import { resetPairingChallengeDeliveryForTest } from "../../src/gateway/pairing-challenge-delivery";
import { handleInboundCommandDispatch } from "../../src/command/inbound-command-dispatch-service";

vi.mock("../../src/command/inbound-command-dispatch-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/command/inbound-command-dispatch-service")>();
  return { ...actual, handleInboundCommandDispatch: vi.fn(actual.handleInboundCommandDispatch) };
});

function pairingRuntime() {
  const runtime = buildRuntime();
  // Use an isolated store; these tests never read the live host state.
  runtime.channel.session.resolveStorePath.mockReturnValue(join(storeDir, "sessions.json"));
  runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: false });
  return {
    channel: {
      ...runtime.channel,
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "TEST2345", created: true }),
        buildPairingReply: vi.fn(buildPairingReply),
      },
    },
  };
}

let runtime: ReturnType<typeof pairingRuntime>;
let params: HandleDingTalkMessageParams;
let storeDir: string;

async function receive(text = "hello") {
  shared.extractMessageContentMock.mockReturnValue({ text, messageType: "text" });
  params.data.text = { content: text };
  await handleDingTalkMessage(params);
}

function expectNoDispatch() {
  expect(runtime.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
  expect(runtime.channel.session.resolveStorePath).not.toHaveBeenCalled();
  expect(runtime.channel.session.recordInboundSession).not.toHaveBeenCalled();
  expect(runtime.channel.media.saveMediaBuffer).not.toHaveBeenCalled();
  expect(handleInboundCommandDispatch).not.toHaveBeenCalled();
  expect(mockedUpsertInboundMessageContext).not.toHaveBeenCalled();
  expect(shared.invalidateAskUserQuestionsForScopeMock).not.toHaveBeenCalled();
  expect(shared.dispatchDingTalkCardStopCommandMock).not.toHaveBeenCalled();
  expect(shared.createAICardMock).not.toHaveBeenCalled();
  expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
  expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
}

describe("inbound pairing admission", () => {
  beforeEach(() => {
    beforeEachInboundHandlerCard();
    resetPairingChallengeDeliveryForTest();
    vi.mocked(handleInboundCommandDispatch).mockClear();
    storeDir = mkdtempSync(join(tmpdir(), "dingtalk-pairing-"));
    runtime = pairingRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);
    params = {
      cfg: {},
      accountId: "primary",
      sessionWebhook: "https://session.webhook",
      dingtalkConfig: { clientId: "test-id", clientSecret: "test-secret", dmPolicy: "pairing", messageType: "markdown", ackReaction: "" },
      data: {
        msgId: "pairing-test",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_direct",
        senderId: "raw-user",
        senderStaffId: "staff-1",
        chatbotUserId: "bot",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    };
  });

  afterEach(() => rmSync(storeDir, { recursive: true, force: true }));

  it.each(["hello", "/stop", "/new", "/model test/model", "/learn global remember this", "/session-alias bind direct other shared", "@helper /new"])(
    "blocks an unapproved DM before any agent/session/command side effects: %s",
    async (text) => {
      await receive(text);

      expectNoDispatch();
      expect(runtime.channel.pairing.readAllowFromStore).toHaveBeenCalledWith({ channel: "dingtalk", accountId: "primary" });
      expect(runtime.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith({ channel: "dingtalk", accountId: "primary", id: "staff-1" });
      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      const reply = shared.sendBySessionMock.mock.calls[0][2];
      expect(reply).toContain("TEST2345");
      expect(reply).toContain("staff-1");
      expect(reply).toContain("primary");
      expect(reply).toContain("openclaw pairing approve dingtalk TEST2345");
    },
  );

  it.each(["store", "allowFrom", "wildcard"])("allows messages and host commands via %s", async (source) => {
    if (source === "store") runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["dd:STAFF-1"]);
    else params.dingtalkConfig.allowFrom = source === "wildcard" ? ["*"] : ["ding:STAFF-1"];

    for (const text of ["hello", "/model test/model"]) await receive(text);

    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(expect.objectContaining({ CommandAuthorized: true, SenderId: "staff-1", AccountId: "primary" }));
    expect(runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it("keeps approval reads and requests isolated by channel and account", async () => {
    const approvals = new Map([
      ["dingtalk:secondary", ["staff-1"]],
      ["telegram:primary", ["staff-1"]],
    ]);
    runtime.channel.pairing.readAllowFromStore.mockImplementation(async ({ channel, accountId }) => approvals.get(`${channel}:${accountId}`) ?? []);
    await receive();
    expectNoDispatch();

    params.accountId = "secondary";
    await receive();
    expect(runtime.channel.pairing.readAllowFromStore).toHaveBeenLastCalledWith({ channel: "dingtalk", accountId: "secondary" });
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("requires a new message after approval and rechecks approval after revocation", async () => {
    await receive();
    expectNoDispatch();
    runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["staff-1"]);
    await receive();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    runtime.channel.pairing.readAllowFromStore.mockResolvedValue([]);
    runtime.channel.pairing.upsertPairingRequest.mockResolvedValue({ code: "TEST2345", created: false });
    await receive("/model test/model");
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(runtime.channel.pairing.readAllowFromStore).toHaveBeenCalledTimes(3);
  });

  it("uses the same account approval for an explicitly routed agent/session", async () => {
    runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["staff-1"]);
    params.routeOverride = { agentId: "helper", sessionKey: "agent:helper:dingtalk:direct:staff-1", mainSessionKey: "agent:helper:main", accountId: "primary" };
    params.subAgentOptions = { agentId: "helper", matchedName: "Helper", responsePrefix: "[Helper]" };
    await receive();

    expect(runtime.channel.pairing.readAllowFromStore).toHaveBeenCalledWith({ channel: "dingtalk", accountId: "primary" });
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(expect.objectContaining({ SessionKey: params.routeOverride.sessionKey, AccountId: "primary", CommandAuthorized: true }));
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("cannot bypass admission through an agent/session route override", async () => {
    params.routeOverride = { agentId: "helper", sessionKey: "agent:helper:main", mainSessionKey: "agent:helper:main", accountId: "primary" };
    params.subAgentOptions = { agentId: "helper", matchedName: "Helper", responsePrefix: "[Helper]", commandText: "/new" };
    await receive();
    expectNoDispatch();
  });

  it.each([undefined, ["staff-1"], ["*"]])("fails closed on store read failure with allowFrom=%j", async (allowFrom) => {
    params.dingtalkConfig.allowFrom = allowFrom;
    runtime.channel.pairing.readAllowFromStore.mockRejectedValue(new Error("store unavailable"));
    await receive();
    expectNoDispatch();
    expect(runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime pairing API is missing", async () => {
    shared.getRuntimeMock.mockReturnValue({ channel: { ...runtime.channel, pairing: undefined } });
    await receive();
    expectNoDispatch();
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it("delivers an existing pending challenge once when delivery state is unknown", async () => {
    runtime.channel.pairing.upsertPairingRequest.mockResolvedValue({ code: "TEST2345", created: false });
    await receive();
    await receive();
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not send a challenge when the host request quota returns no code", async () => {
    runtime.channel.pairing.upsertPairingRequest.mockResolvedValue({ code: "", created: false });
    await receive();
    expectNoDispatch();
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it.each(["upsert", "reply"])("still blocks when %s fails", async (failure) => {
    if (failure === "upsert") runtime.channel.pairing.upsertPairingRequest.mockRejectedValue(new Error("store unavailable"));
    else shared.sendBySessionMock.mockRejectedValue(new Error("send unavailable"));
    await receive();
    expectNoDispatch();
  });

  it("uses senderId when no staff ID is available, and never pairs a blank identity", async () => {
    params.data.senderStaffId = undefined;
    await receive();
    expect(runtime.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "raw-user" }));
    runtime.channel.pairing.upsertPairingRequest.mockClear();
    params.data.senderId = " ";
    params.dingtalkConfig.allowFrom = ["*"];
    await receive();
    expectNoDispatch();
    expect(runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it.each([
    { dmPolicy: "open", conversationType: "1", groupPolicy: "open", allowed: true },
    { dmPolicy: "allowlist", conversationType: "1", groupPolicy: "open", allowed: false },
    { dmPolicy: "pairing", conversationType: "2", groupPolicy: "open", allowed: true },
    { dmPolicy: "pairing", conversationType: "2", groupPolicy: "disabled", allowed: false },
    { dmPolicy: "pairing", conversationType: "2", groupPolicy: "allowlist", allowed: false },
  ] as const)("does not use DM pairing approval to alter $dmPolicy/$groupPolicy chatType=$conversationType", async (scenario) => {
    Object.assign(params.dingtalkConfig, { dmPolicy: scenario.dmPolicy, groupPolicy: scenario.groupPolicy });
    params.data.conversationType = scenario.conversationType;
    runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["staff-1"]);
    await receive();
    expect(runtime.channel.pairing.readAllowFromStore).not.toHaveBeenCalled();
    expect(runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(scenario.allowed ? 1 : 0);
  });

  it.each([undefined, ["dingtalk:other-owner"]])("does not grant owner-only learning permissions with ownerAllowFrom=%j", async (ownerAllowFrom) => {
    runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["staff-1"]);
    params.dingtalkConfig.learningEnabled = true;
    params.dingtalkConfig.learningAllowManualGlobalRules = true;
    params.cfg = { commands: { ownerAllowFrom } };
    await receive("/learn global remember this");
    expect(handleInboundCommandDispatch).toHaveBeenCalled();
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining("仅允许 owner"), expect.anything());
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(params.cfg.commands?.ownerAllowFrom).toEqual(ownerAllowFrom);
  });
});
