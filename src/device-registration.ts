import { exec } from "node:child_process";
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

async function apiPost(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${REGISTRATION_BASE_URL}${path}`;
  const resp = await httpClient.post(url, payload, { timeout: 15_000 });
  const data = resp.data as Record<string, unknown>;
  const errcode = data.errcode;
  if (errcode !== undefined && errcode !== 0) {
    const errmsg = data.errmsg ?? "unknown error";
    throw new RegistrationError(`API error [${path}]: ${errmsg} (errcode=${errcode})`);
  }
  return data;
}

// ── Step 1: init → nonce ───────────────────────────────────────────────────

async function initRegistration(): Promise<string> {
  const data = await apiPost("/app/registration/init", { source: REGISTRATION_SOURCE });
  const nonce = String(data.nonce ?? "").trim();
  if (!nonce) {
    throw new RegistrationError("init response missing nonce");
  }
  return nonce;
}

// ── Step 2: begin → deviceCode + verificationUrl ───────────────────────────

async function beginRegistration(nonce: string): Promise<BeginResult> {
  const data = await apiPost("/app/registration/begin", { nonce });
  const deviceCode = String(data.device_code ?? "").trim();
  const verificationUrl = String(data.verification_uri_complete ?? "").trim();
  if (!deviceCode) {
    throw new RegistrationError("begin response missing device_code");
  }
  if (!verificationUrl) {
    throw new RegistrationError("begin response missing verification_uri_complete");
  }
  return {
    deviceCode,
    verificationUrl,
    expiresIn: Number(data.expires_in ?? 7200),
    interval: Math.max(Number(data.interval ?? 3), 2),
  };
}

// ── Step 3: poll ───────────────────────────────────────────────────────────

async function pollRegistration(deviceCode: string): Promise<PollResult> {
  const data = await apiPost("/app/registration/poll", { device_code: deviceCode });
  const raw = String(data.status ?? "").trim().toUpperCase();
  const status: PollStatus = ["WAITING", "SUCCESS", "FAIL", "EXPIRED"].includes(raw)
    ? (raw as PollStatus)
    : "FAIL";
  return {
    status,
    clientId: String(data.client_id ?? "").trim() || undefined,
    clientSecret: String(data.client_secret ?? "").trim() || undefined,
    failReason: String(data.fail_reason ?? "").trim() || undefined,
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
    let retryStart = 0;

    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new RegistrationError("registration cancelled");
      }

      await new Promise((resolve) => setTimeout(resolve, interval * 1000));

      let result: PollResult;
      try {
        result = await pollRegistration(deviceCode);
      } catch {
        if (!retryStart) retryStart = Date.now();
        if (Date.now() - retryStart < RETRY_WINDOW_MS) continue;
        throw new RegistrationError("registration polling failed after retry window");
      }

      const { status } = result;

      if (status === "WAITING") {
        retryStart = 0;
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

      // FAIL / EXPIRED — retry within window
      if (!retryStart) retryStart = Date.now();
      if (Date.now() - retryStart < RETRY_WINDOW_MS) continue;
      throw new RegistrationError(
        `authorization failed: ${result.failReason ?? status}`,
      );
    }

    throw new RegistrationError("authorization timed out, please retry");
  };

  return { verificationUrl, waitForResult };
}

// ── Browser helper ─────────────────────────────────────────────────────────

export function openUrlInBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, (err) => {
    // Silently ignore — caller falls back to note() with the URL
    void err;
  });
}
