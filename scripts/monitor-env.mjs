import fs from "node:fs";
import path from "node:path";

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(envFilePath) {
  const resolved = path.resolve(envFilePath);
  if (!fs.existsSync(resolved)) {
    return { loaded: false, resolved };
  }

  const raw = fs.readFileSync(resolved, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalIndex).trim();
    const value = stripQuotes(trimmed.slice(equalIndex + 1).trim());
    if (!key) {
      continue;
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return { loaded: true, resolved };
}

export function parseArgs(argv) {
  const out = {
    clientId: process.env.DINGTALK_CLIENT_ID?.trim() || "",
    clientSecret: process.env.DINGTALK_CLIENT_SECRET?.trim() || "",
    sdkDebug: process.env.DINGTALK_MONITOR_SDK_DEBUG === "1",
    sdkKeepAlive: process.env.DINGTALK_MONITOR_SDK_KEEPALIVE !== "0",
    durationSec: Number.parseInt(process.env.DINGTALK_MONITOR_DURATION_SEC ?? "0", 10) || 0,
    summaryEverySec: Number.parseInt(process.env.DINGTALK_MONITOR_SUMMARY_EVERY_SEC ?? "30", 10) || 30,
    probeEverySec: Number.parseInt(process.env.DINGTALK_MONITOR_PROBE_EVERY_SEC ?? "20", 10) || 20,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--duration" && next) {
      out.durationSec = Number.parseInt(next, 10) || out.durationSec;
      i += 1;
    } else if (arg === "--client-id" && next) {
      out.clientId = next.trim();
      i += 1;
    } else if (arg === "--client-secret" && next) {
      out.clientSecret = next.trim();
      i += 1;
    } else if (arg === "--client-secret" && next) {
      out.clientSecret = next.trim();
      i += 1;
    } else if (arg === "--summary-every" && next) {
      out.summaryEverySec = Number.parseInt(next, 10) || out.summaryEverySec;
      i += 1;
    } else if (arg === "--probe-every" && next) {
      out.probeEverySec = Number.parseInt(next, 10) || out.probeEverySec;
      i += 1;
    } else if (arg === "--sdk-debug") {
      out.sdkDebug = true;
    } else if (arg === "--no-sdk-debug") {
      out.sdkDebug = false;
    } else if (arg === "--sdk-keepalive") {
      out.sdkKeepAlive = true;
    } else if (arg === "--no-sdk-keepalive") {
      out.sdkKeepAlive = false;
    }
  }

  if (out.summaryEverySec < 5) {
    out.summaryEverySec = 5;
  }
  if (out.probeEverySec < 5) {
    out.probeEverySec = 5;
  }
  return out;
}

export function getCliValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) {
    return String(argv[idx + 1]).trim();
  }
  return "";
}
