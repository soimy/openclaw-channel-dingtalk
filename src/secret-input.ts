import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

export type SecretInputRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

export type SecretInput = string | SecretInputRef;

export const SECRET_INPUT_EXEC_TIMEOUT_MS = 5000;

export function buildSecretInputSchema() {
  return z.union([
    z.string(),
    z.object({
      source: z.enum(["env", "file", "exec"]),
      provider: z.string().min(1),
      id: z.string().min(1),
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

export function resolveSecretInputString(value: unknown): string | undefined {
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
      const filePath = value.id.startsWith("~/")
        ? path.resolve(os.homedir(), value.id.slice(2))
        : path.resolve(value.id);
      return readFileSync(filePath, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return (
      execFileSync(value.provider, [value.id], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SECRET_INPUT_EXEC_TIMEOUT_MS,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function resolveDingTalkSecretConfig<T extends { clientSecret?: unknown }>(
  config: T,
): T & { clientSecret?: string } {
  return {
    ...config,
    clientSecret: resolveSecretInputString(config.clientSecret),
  };
}
