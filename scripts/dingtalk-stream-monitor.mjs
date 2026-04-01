#!/usr/bin/env node

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { getCliValue, loadEnvFile, parseArgs } from "./monitor-env.mjs";

function mask(value) {
  if (!value || value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createState(startMs) {
  return {
    startMs,
    ended: false,
    connectSuccess: 0,
    connectFailures: 0,
    socketClose: 0,
    socketError: 0,
    sdkHeartbeatLog: 0,
    sdkKeepaliveLog: 0,
    sdkPingLog: 0,
    callbackReceived: 0,
    callbackAcked: 0,
    callbackParseError: 0,
    callbackDuplicateId: 0,
    callbackNoMsgId: 0,
    callbackNoHeaderMsgId: 0,
    probeOk: 0,
    probeFail: 0,
    lastCallbackAt: 0,
    seenMsgIds: new Set(),
    lastSocketCloseAt: 0,
    lastSocketErrorAt: 0,
  };
}

function logLine(level, message, extra) {
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`${nowIso()} ${level} ${message}${payload}`);
}

async function probeApi(state) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://api.dingtalk.com", {
      method: "GET",
      signal: controller.signal,
    });
    if (res.ok || res.status === 404) {
      state.probeOk += 1;
      return;
    }
    state.probeFail += 1;
    logLine("warn", "probe api unexpected status", { status: res.status });
  } catch (err) {
    state.probeFail += 1;
    logLine("warn", "probe api failed", { error: String(err) });
  } finally {
    clearTimeout(timeoutId);
  }
}

function printSummary(state) {
  const uptimeSec = Math.max(1, Math.floor((Date.now() - state.startMs) / 1000));
  const callbackPerMin = Number(((state.callbackReceived / uptimeSec) * 60).toFixed(2));
  const silentSec = state.lastCallbackAt > 0 ? Math.floor((Date.now() - state.lastCallbackAt) / 1000) : null;

  logLine("info", "monitor summary", {
    uptimeSec,
    callbackReceived: state.callbackReceived,
    callbackAcked: state.callbackAcked,
    callbackParseError: state.callbackParseError,
    callbackDuplicateId: state.callbackDuplicateId,
    callbackNoMsgId: state.callbackNoMsgId,
    callbackNoHeaderMsgId: state.callbackNoHeaderMsgId,
    callbackPerMin,
    socketClose: state.socketClose,
    socketError: state.socketError,
    sdkHeartbeatLog: state.sdkHeartbeatLog,
    sdkKeepaliveLog: state.sdkKeepaliveLog,
    sdkPingLog: state.sdkPingLog,
    probeOk: state.probeOk,
    probeFail: state.probeFail,
    silentSec,
  });
}

function printHeuristicConclusion(state) {
  const hasTransportInstability = state.socketClose > 0 || state.socketError > 0;
  const hasSdkHeartbeat = state.sdkHeartbeatLog > 0 || state.sdkKeepaliveLog > 0;
  const hasCallbackFlow = state.callbackReceived > 0;
  const apiProbeBad = state.probeFail > state.probeOk;

  let conclusion = "inconclusive";
  if (hasTransportInstability && apiProbeBad) {
    conclusion = "likely network or upstream instability (outside local handler)";
  } else if (hasTransportInstability && !apiProbeBad && hasSdkHeartbeat) {
    conclusion = "stream transport unstable while api probe is mostly healthy (possible server stream path or ws route issue)";
  } else if (!hasTransportInstability && hasSdkHeartbeat && !hasCallbackFlow) {
    conclusion = "stream alive but no callbacks observed (possible server push/permission/subscription issue)";
  } else if (hasCallbackFlow) {
    conclusion = "callbacks are arriving locally; missing user-perceived messages likely in upstream push semantics or downstream business processing";
  }

  logLine("info", "heuristic conclusion", { conclusion });
}

async function main() {
  const envFile = getCliValue(process.argv.slice(2), "--env-file") || ".env.dingtalk-monitor.local";
  const envLoadResult = loadEnvFile(envFile);
  const args = parseArgs(process.argv.slice(2));
  const clientId = args.clientId;
  const clientSecret = args.clientSecret;

  if (!clientId || !clientSecret) {
    console.error(
      "Missing required credentials. Provide via env (`DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`) or args (`--client-id`, `--client-secret`).",
    );
    process.exit(1);
  }
  const state = createState(Date.now());

  logLine("info", "starting dingtalk stream monitor", {
    envFile: envLoadResult.resolved,
    envFileLoaded: envLoadResult.loaded,
    clientId: mask(clientId),
    sdkDebug: args.sdkDebug,
    sdkKeepAlive: args.sdkKeepAlive,
    durationSec: args.durationSec,
    summaryEverySec: args.summaryEverySec,
    probeEverySec: args.probeEverySec,
  });

  const client = new DWClient({
    clientId,
    clientSecret,
    keepAlive: args.sdkKeepAlive,
    debug: args.sdkDebug,
  });

  const originalPrintDebug = client.printDebug.bind(client);
  client.printDebug = (msg) => {
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    if (text.includes("CLIENT-SIDE HEARTBEAT")) {
      state.sdkHeartbeatLog += 1;
    }
    if (text.includes("KEEPALIVE")) {
      state.sdkKeepaliveLog += 1;
    }
    if (text.includes("PING")) {
      state.sdkPingLog += 1;
    }
    originalPrintDebug(msg);
  };

  let observedSocket = null;
  const bindSocketEvents = () => {
    const socket = client.socket;
    if (!socket || socket === observedSocket) {
      return;
    }
    observedSocket = socket;
    socket.on("close", (code, reason) => {
      state.socketClose += 1;
      state.lastSocketCloseAt = Date.now();
      logLine("warn", "ws close", {
        code,
        reason: typeof reason === "string" ? reason : String(reason || ""),
      });
    });
    socket.on("error", (err) => {
      state.socketError += 1;
      state.lastSocketErrorAt = Date.now();
      logLine("warn", "ws error", { error: String(err) });
    });
  };

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    state.callbackReceived += 1;
    state.lastCallbackAt = Date.now();

    const streamMessageId = res?.headers?.messageId;
    if (!streamMessageId) {
      state.callbackNoHeaderMsgId += 1;
    }

    if (streamMessageId) {
      try {
        client.socketCallBackResponse(streamMessageId, { success: true });
        state.callbackAcked += 1;
      } catch (err) {
        logLine("warn", "callback ack failed", { error: String(err), streamMessageId });
      }
    }

    try {
      const data = JSON.parse(res.data);
      const msgId = data?.msgId;
      if (!msgId) {
        state.callbackNoMsgId += 1;
      } else if (state.seenMsgIds.has(msgId)) {
        state.callbackDuplicateId += 1;
      } else {
        state.seenMsgIds.add(msgId);
        if (state.seenMsgIds.size > 20000) {
          state.seenMsgIds.clear();
        }
      }
    } catch {
      state.callbackParseError += 1;
    }
  });

  const periodicSocketBindTimer = setInterval(bindSocketEvents, 1000);
  const summaryTimer = setInterval(() => printSummary(state), args.summaryEverySec * 1000);
  const probeTimer = setInterval(() => {
    void probeApi(state);
  }, args.probeEverySec * 1000);

  const shutdown = async (signal) => {
    if (state.ended) {
      return;
    }
    state.ended = true;
    logLine("info", `received ${signal}, shutting down`);
    clearInterval(periodicSocketBindTimer);
    clearInterval(summaryTimer);
    clearInterval(probeTimer);
    try {
      client.disconnect();
    } catch (err) {
      logLine("warn", "disconnect failed", { error: String(err) });
    }
    printSummary(state);
    printHeuristicConclusion(state);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await client.connect();
    state.connectSuccess += 1;
    bindSocketEvents();
    logLine("info", "stream connected");
  } catch (err) {
    state.connectFailures += 1;
    logLine("error", "stream connect failed", { error: String(err) });
    await shutdown("connect-failed");
    return;
  }

  await probeApi(state);

  if (args.durationSec > 0) {
    setTimeout(() => {
      void shutdown("duration-reached");
    }, args.durationSec * 1000);
  }
}

void main();
