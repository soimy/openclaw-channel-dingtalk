import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPairingReply,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { HandleDingTalkMessageParams } from "../../src/platform/types";
import {
  shared,
  buildRuntime,
  beforeEachInboundHandlerCard,
  mockedUpsertInboundMessageContext,
} from "../unit/fixtures/inbound-handler-card";
import { handleDingTalkMessage } from "../../src/gateway/inbound-handler";
import { resetPairingChallengeDeliveryForTest } from "../../src/gateway/pairing-challenge-delivery";

type ApprovalInput = { channel: string; accountId: string; code: string; env: NodeJS.ProcessEnv; pairingAdapter: { idLabel: string } };
let approveCode: (input: ApprovalInput) => Promise<unknown>;
let stateDir: string;
let env: NodeJS.ProcessEnv;
let runtime: ReturnType<typeof buildRuntime>;
let params: HandleDingTalkMessageParams;

beforeAll(async () => {
  // The pinned SDK exposes store reads/requests publicly, but its CLI approval mutator is internal.
  // Discover that actual mutator rather than mocking SQLite approval or hardcoding a bundle hash.
  const dist = resolve(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/conversation-runtime")), "..");
  const file = readdirSync(dist).find((name) => name.startsWith("pairing-store-") && name.endsWith(".js") && readFileSync(join(dist, name), "utf8").includes("function approveChannelPairingCode("));
  if (!file) throw new Error("Pinned OpenClaw SDK pairing approval mutator not found");
  const store = await import(/* @vite-ignore */ pathToFileURL(join(dist, file)).href);
  approveCode = Object.values(store).find((value) => typeof value === "function" && value.name === "approveChannelPairingCode") as typeof approveCode;
  expect(approveCode).toBeTypeOf("function");
});

beforeEach(() => {
  beforeEachInboundHandlerCard();
  resetPairingChallengeDeliveryForTest();
  stateDir = mkdtempSync(join(tmpdir(), "dingtalk-sdk-pairing-"));
  env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json") };
  runtime = buildRuntime();
  runtime.channel.session.resolveStorePath.mockReturnValue(join(stateDir, "sessions.json"));
  runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: false });
  shared.getRuntimeMock.mockReturnValue({
    channel: {
      ...runtime.channel,
      pairing: {
        readAllowFromStore: ({ channel, accountId }: { channel: string; accountId: string }) => readChannelAllowFromStore(channel, env, accountId),
        upsertPairingRequest: (input: Parameters<typeof upsertChannelPairingRequest>[0]) => upsertChannelPairingRequest({ ...input, env }),
        buildPairingReply,
      },
    },
  });
  params = {
    cfg: {},
    accountId: "primary",
    sessionWebhook: "https://session.webhook",
    dingtalkConfig: { clientId: "test-id", clientSecret: "test-secret", dmPolicy: "pairing", messageType: "markdown", ackReaction: "" },
    data: { msgId: "sdk-pairing", msgtype: "text", text: { content: "hello" }, conversationType: "1", conversationId: "cid_direct", senderId: "staff-1", chatbotUserId: "bot", sessionWebhook: "https://session.webhook", createAt: Date.now() },
  };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(stateDir, { recursive: true, force: true });
});

async function approve(accountId: string) {
  const { code } = await upsertChannelPairingRequest({ channel: "dingtalk", accountId, id: "staff-1", env });
  expect(code).not.toBe("");
  // An explicit adapter keeps host approval normalization out of the live plugin registry.
  expect(await approveCode({ channel: "dingtalk", accountId, code, env, pairingAdapter: { idLabel: "dingtalkUserId" } })).toBeTruthy();
}

function configure(ids: string[], withDefault = false) {
  params.cfg = { channels: { dingtalk: {
    ...(withDefault ? { clientId: "default-id", clientSecret: "default-secret" } : {}),
    dmPolicy: "pairing",
    accounts: Object.fromEntries(ids.map((id, index) => [id, { clientId: `bot-${index}`, clientSecret: "test-secret" }])),
  } } };
}

function expectNoDispatch() {
  expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(runtime.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
  expect(runtime.channel.session.resolveStorePath).not.toHaveBeenCalled();
  expect(runtime.channel.session.recordInboundSession).not.toHaveBeenCalled();
  expect(runtime.channel.media.saveMediaBuffer).not.toHaveBeenCalled();
  expect(mockedUpsertInboundMessageContext).not.toHaveBeenCalled();
  expect(shared.sendBySessionMock).not.toHaveBeenCalled();
}

async function expectIdentityRejected(pattern = /account.*pairing identity/i) {
  const error = await handleDingTalkMessage(params).then(() => undefined, (error) => error);
  expectNoDispatch();
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(pattern);
}

describe("real SDK pairing account identities", () => {
  it("delivers pre-existing pending requests once per process without granting access", async () => {
    configure(["primary"]);
    const pending = await upsertChannelPairingRequest({ channel: "dingtalk", accountId: "primary", id: "staff-1", env });
    expect(pending.created).toBe(true);
    await handleDingTalkMessage(params);
    params.data.msgId = "pending-hint-already-sent";
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0][2]).toContain(pending.code);
    resetPairingChallengeDeliveryForTest();
    params.data.msgId = "pending-hint-after-restart";
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(2);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(await readChannelAllowFromStore("dingtalk", env, "primary")).toEqual([]);
  });

  it("delivers a fresh hint when the real SDK expires the pending request and replaces its code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    configure(["primary"]);
    await handleDingTalkMessage(params);
    const first = await upsertChannelPairingRequest({ channel: "dingtalk", accountId: "primary", id: "staff-1", env });
    vi.advanceTimersByTime(60 * 60_000 + 1);
    params.data.msgId = "pending-hint-after-expiry";
    await handleDingTalkMessage(params);
    const next = await upsertChannelPairingRequest({ channel: "dingtalk", accountId: "primary", id: "staff-1", env });
    expect(next.code).not.toBe(first.code);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(2);
    expect(shared.sendBySessionMock.mock.calls[1][2]).toContain(next.code);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent real SDK requests while the hint transport is in flight", async () => {
    configure(["primary"]);
    let release!: () => void;
    shared.sendBySessionMock.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = handleDingTalkMessage({ ...params, data: { ...params.data, msgId: "concurrent-first" } });
    await vi.waitFor(() => expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1));
    await handleDingTalkMessage({ ...params, data: { ...params.data, msgId: "concurrent-second" } });
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    release();
    await first;
    await handleDingTalkMessage({ ...params, data: { ...params.data, msgId: "after-concurrent-success" } });
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(await readChannelAllowFromStore("dingtalk", env, "primary")).toEqual([]);
  });

  it("retries a failed pairing hint after cooldown without admitting unapproved messages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    configure(["primary"]);
    shared.sendBySessionMock.mockRejectedValueOnce(new Error("simulated transport failure"));
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    const pending = await upsertChannelPairingRequest({ channel: "dingtalk", accountId: "primary", id: "staff-1", env });
    expect(pending.created).toBe(false);
    expect(shared.sendBySessionMock.mock.calls[0][2]).toContain(pending.code);

    shared.sendBySessionMock.mockResolvedValue(undefined);
    vi.advanceTimersByTime(59_999);
    params.data.msgId = "pairing-retry-too-soon";
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    params.data.msgId = "pairing-retry-after-recovery";
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(2);
    expect(shared.sendBySessionMock.mock.calls[1][2]).toContain(pending.code);
    params.data.msgId = "pairing-retry-already-delivered";
    await handleDingTalkMessage(params);
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(2);
    expect(runtime.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(runtime.channel.session.recordInboundSession).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(await readChannelAllowFromStore("dingtalk", env, "primary")).toEqual([]);
  });

  it("confirms the actual SDK aliases case, whitespace, and blank/default account keys", async () => {
    await approve("Main");
    for (const id of ["Main", "main", " main "]) {
      expect(await readChannelAllowFromStore("dingtalk", env, id)).toEqual(["staff-1"]);
    }
    await approve("default");
    for (const id of ["default", "", " "]) {
      expect(await readChannelAllowFromStore("dingtalk", env, id)).toEqual(["staff-1"]);
    }
  });

  it.each([["Main", "main"], ["primary ", "primary"], [" primary", "primary"]])(
    "rejects both colliding bot identities %j and %j before any dispatch",
    async (first, second) => {
      await approve(first);
      configure([first, second]);
      for (const accountId of [second, first]) {
        params.accountId = accountId;
        await expectIdentityRejected();
      }
    },
  );

  it.each(["Default", " default "])("rejects %j colliding with the implicit default account", async (accountId) => {
    await approve("default");
    configure([accountId], true);
    params.accountId = accountId;
    await expectIdentityRejected(/default.*pairing identity/i);
  });

  it.each(["", " "])("rejects blank configured/requested account %j instead of using default approval", async (accountId) => {
    await approve("default");
    configure([accountId]);
    params.accountId = accountId;
    await expectIdentityRejected(/account.*empty|account.*whitespace/i);
  });

  it("does not accept an unconfigured normalized alias of a configured account", async () => {
    await approve("Main");
    configure(["Main"]);
    params.accountId = "main";
    await expectIdentityRejected();
  });

  it("preserves real approval/request isolation for primary and secondary", async () => {
    await approve("primary");
    configure(["primary", "secondary"]);
    await handleDingTalkMessage(params);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    params.accountId = "secondary";
    await handleDingTalkMessage(params);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(await readChannelAllowFromStore("dingtalk", env, "secondary")).toEqual([]);
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining("Pairing code"), expect.anything());
    expect(await readChannelAllowFromStore("telegram", env, "primary")).toEqual([]);
  });

  it.each(["Main", " primary "])("preserves a single unambiguous raw account ID %j", async (accountId) => {
    await approve(accountId);
    configure([accountId]);
    params.accountId = accountId;
    await handleDingTalkMessage(params);
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(expect.objectContaining({ AccountId: accountId }));
  });
});
