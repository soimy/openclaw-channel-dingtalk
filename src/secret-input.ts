import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export type SecretInputRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

export type SecretInput = string | SecretInputRef;

export const SECRET_INPUT_EXEC_TIMEOUT_MS = 5000;

type SecretInputLog = {
  warn?: (message: string, data?: unknown) => void;
};

const execFileAsync = promisify(execFile);

export function buildSecretInputSchema() {
  return z.union([
    z.string(),
    z.object({
      source: z.enum(["env", "file", "exec"]),
      provider: z.string().min(1).max(1024),
      id: z.string().min(1).max(1024),
    }),
  ]);
}

export function isSecretInputRef(value: unknown): value is SecretInputRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ref = value as SecretInputRef;
  return (
    (ref.source === "env" || ref.source === "file" || ref.source === "exec") &&
    typeof ref.provider === "string" &&
    ref.provider.trim().length > 0 &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0
  );
}

export function hasConfiguredSecretInput(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!isSecretInputRef(value)) {
    return false;
  }
  if (value.source === "env") {
    return Boolean(process.env[value.id]?.trim());
  }
  // file/exec references are considered configured when the reference shape is
  // present. The actual filesystem/process lookup happens at runtime so status
  // checks can stay side-effect free.
  return true;
}

export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!isSecretInputRef(value)) {
    return undefined;
  }
  return `<${value.source}:${value.provider}:${value.id}>`;
}

export async function resolveSecretInputString(
  value: unknown,
  log?: SecretInputLog,
): Promise<string | undefined> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!isSecretInputRef(value)) {
    return undefined;
  }
  if (value.source === "env") {
    return process.env[value.id]?.trim() || undefined;
  }
  if (value.source === "file") {
    try {
      // Trust boundary: file SecretInput reads the configured local path. Use it
      // only with trusted plugin configuration.
      const filePath = value.id.startsWith("~/")
        ? path.resolve(os.homedir(), value.id.slice(2))
        : path.resolve(value.id);
      return (await readFile(filePath, "utf8")).trim() || undefined;
    } catch (error) {
      log?.warn?.("[DingTalk][SecretInput] Failed to read file secret", {
        provider: value.provider,
        id: value.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  try {
    // Trust boundary: exec SecretInput runs the configured provider binary with
    // the secret id as its only argument. Use it only with trusted plugin
    // configuration; execFile avoids shell interpolation but still executes the
    // selected program.
    const result = await execFileAsync(value.provider, [value.id], {
      encoding: "utf8",
      timeout: SECRET_INPUT_EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    const stdout = typeof result === "string" ? result : result.stdout;
    return String(stdout).trim() || undefined;
  } catch (error) {
    log?.warn?.("[DingTalk][SecretInput] Failed to resolve exec secret", {
      provider: value.provider,
      id: value.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function resolveDingTalkSecretConfig<T extends { clientSecret?: unknown }>(
  config: T,
  log?: SecretInputLog,
): Promise<T & { clientSecret?: string }> {
  return {
    ...config,
    clientSecret: await resolveSecretInputString(config.clientSecret, log),
  };
}
