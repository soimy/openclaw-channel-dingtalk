import { execFile } from "node:child_process";
import httpClient from "./http-client.js";

// ── Constants ──────────────────────────────────────────────────────────────

const REGISTRATION_BASE_URL = "https://oapi.dingtalk.com";
const REGISTRATION_SOURCE = "openClaw";
const RETRY_WINDOW_MS = 120_000; // 2 minutes for transient errors

// ── Types ──────────────────────────────────────────────────────────────────

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

export interface RegistrationResult {
  clientId: string;
  clientSecret: string;
}

interface BeginResult {
  deviceCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

type PollStatus = "WAITING" | "SUCCESS" | "FAIL" | "EXPIRED";

interface PollResult {
  status: PollStatus;
  clientId?: string;
  clientSecret?: string;
  failReason?: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function apiPost(
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${REGISTRATION_BASE_URL}${path}`;
  const resp = await httpClient.post(url, payload, { timeout: 15_000 });
  const data = resp.data as Record<string, unknown>;
  const errcode = data.errcode;
  if (errcode !== undefined && errcode !== 0) {
    const errmsg = asString(data.errmsg) || "unknown error";
    throw new RegistrationError(`API error [${path}]: ${errmsg} (errcode=${typeof errcode === "number" ? errcode : asString(errcode)})`);
  }
  return data;
}

// ── Step 1: init → nonce ───────────────────────────────────────────────────

async function initRegistration(): Promise<string> {
  const data = await apiPost("/app/registration/init", { source: REGISTRATION_SOURCE });
  const nonce = asString(data.nonce).trim();
  if (!nonce) {
    throw new RegistrationError("init response missing nonce");
  }
  return nonce;
}

// ── Step 2: begin → deviceCode + verificationUrl ───────────────────────────

async function beginRegistration(nonce: string): Promise<BeginResult> {
  const data = await apiPost("/app/registration/begin", { nonce });
  const deviceCode = asString(data.device_code).trim();
  const verificationUrl = asString(data.verification_uri_complete).trim();
  if (!deviceCode) {
    throw new RegistrationError("begin response missing device_code");
  }
  if (!verificationUrl) {
    throw new RegistrationError("begin response missing verification_uri_complete");
  }
  return {
    deviceCode,
    verificationUrl,
    expiresIn: Number(data.expires_in ?? 7200) || 7200,
    interval: Math.max(Number(data.interval ?? 3) || 3, 2),
  };
}

// ── Step 3: poll ───────────────────────────────────────────────────────────

async function pollRegistration(deviceCode: string): Promise<PollResult> {
  const data = await apiPost("/app/registration/poll", { device_code: deviceCode });
  const raw = asString(data.status).trim().toUpperCase();
  const status: PollStatus = ["WAITING", "SUCCESS", "FAIL", "EXPIRED"].includes(raw)
    ? (raw as PollStatus)
    : "FAIL";
  return {
    status,
    clientId: asString(data.client_id).trim() || undefined,
    clientSecret: asString(data.client_secret).trim() || undefined,
    failReason: asString(data.fail_reason).trim() || undefined,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface DeviceRegistrationSession {
  verificationUrl: string;
  waitForResult: (options?: {
    onWaiting?: () => void;
    signal?: AbortSignal;
  }) => Promise<RegistrationResult>;
}

export async function beginDeviceRegistration(): Promise<DeviceRegistrationSession> {
  const nonce = await initRegistration();
  const { deviceCode, verificationUrl, expiresIn, interval } = await beginRegistration(nonce);

  const waitForResult = async (options?: {
    onWaiting?: () => void;
    signal?: AbortSignal;
  }): Promise<RegistrationResult> => {
    const deadline = Date.now() + expiresIn * 1000;
    let networkRetryStart = 0;
    let statusRetryStart = 0;

    const signal = options?.signal;
    let abortHandler: (() => void) | null = null;
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          abortHandler = () => reject(new RegistrationError("registration cancelled"));
          signal.addEventListener("abort", abortHandler, { once: true });
        })
      : null;
    // Suppress unhandled rejection when abort fires outside Promise.race
    abortPromise?.catch(() => {});

    const sleep = () =>
      new Promise((resolve) => setTimeout(resolve, interval * 1000));

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw new RegistrationError("registration cancelled");
        }

        // AbortSignal-aware sleep
        await (abortPromise ? Promise.race([sleep(), abortPromise]) : sleep());

        // Check again after sleep — abort may have fired during sleep
        if (signal?.aborted) {
          throw new RegistrationError("registration cancelled");
        }

        let result: PollResult;
        try {
          result = await pollRegistration(deviceCode);
        } catch {
          if (!networkRetryStart) {
            networkRetryStart = Date.now();
          }
          if (Date.now() - networkRetryStart < RETRY_WINDOW_MS) {
            continue;
          }
          throw new RegistrationError("registration polling failed after retry window");
        }

        // Successful poll resets network retry window
        networkRetryStart = 0;

        const { status } = result;

        if (status === "WAITING") {
          statusRetryStart = 0;
          options?.onWaiting?.();
          continue;
        }

        if (status === "SUCCESS") {
          const clientId = result.clientId;
          const clientSecret = result.clientSecret;
          if (!clientId || !clientSecret) {
            throw new RegistrationError("authorization succeeded but credentials are missing");
          }
          return { clientId, clientSecret };
        }

        if (status === "EXPIRED") {
          throw new RegistrationError("authorization expired, please restart registration");
        }

        // FAIL — retry within window
        if (!statusRetryStart) {
          statusRetryStart = Date.now();
        }
        if (Date.now() - statusRetryStart < RETRY_WINDOW_MS) {
          continue;
        }
        throw new RegistrationError(`authorization failed: ${result.failReason ?? status}`);
      }

      throw new RegistrationError("authorization timed out, please retry");
    } finally {
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  };

  return { verificationUrl, waitForResult };
}

// ── Browser helper ─────────────────────────────────────────────────────────

export function openUrlInBrowser(url: string): void {
  const platform = process.platform;
  let bin: string;
  let args: string[];
  if (platform === "darwin") {
    bin = "open";
    args = [url];
  } else if (platform === "win32") {
    bin = "cmd";
    args = ["/c", "start", "", url];
  } else {
    bin = "xdg-open";
    args = [url];
  }
  execFile(bin, args, (err) => {
    void err;
  });
}
