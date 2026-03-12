import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./types";

type NamespaceFormat = "json";

export interface PersistenceScope {
  accountId?: string;
  agentId?: string;
  conversationId?: string;
  groupId?: string;
  targetId?: string;
}

export interface ResolveNamespacePathOptions {
  storePath: string;
  scope?: PersistenceScope;
  format?: NamespaceFormat;
}

export interface ReadNamespaceJsonOptions<T> extends ResolveNamespacePathOptions {
  fallback: T;
  log?: Logger;
}

export interface WriteNamespaceJsonOptions<T> extends ResolveNamespacePathOptions {
  data: T;
  log?: Logger;
}

const NAMESPACE_ROOT_DIR = "dingtalk-state";
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function encodeScopeValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildScopeSuffix(scope?: PersistenceScope): string {
  if (!scope) {
    return "";
  }
  const ordered: Array<[keyof PersistenceScope, string | undefined]> = [
    ["accountId", scope.accountId],
    ["agentId", scope.agentId],
    ["conversationId", scope.conversationId],
    ["groupId", scope.groupId],
    ["targetId", scope.targetId],
  ];

  const segments = ordered
    .filter(([, value]) => Boolean(value && value.trim()))
    .map(([key, value]) => `${key.replace(/Id$/, "")}-${encodeScopeValue((value || "").trim())}`);

  if (segments.length === 0) {
    return "";
  }
  return `.${segments.join(".")}`;
}

export function resolveNamespacePath(namespace: string, options: ResolveNamespacePathOptions): string {
  const format = options.format || "json";
  const baseDir = path.join(path.dirname(options.storePath), NAMESPACE_ROOT_DIR);
  const safeNamespace = sanitizeSegment(namespace.trim());
  const suffix = buildScopeSuffix(options.scope);
  return path.join(baseDir, `${safeNamespace}${suffix}.${format}`);
}

export function readNamespaceJson<T>(
  namespace: string,
  options: ReadNamespaceJsonOptions<T>,
): T {
  const filePath = resolveNamespacePath(namespace, options);
  try {
    if (!fs.existsSync(filePath)) {
      return options.fallback;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return options.fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    options.log?.warn?.(
      `[DingTalk][Persistence] Failed to read namespace=${namespace} path=${filePath}: ${toErrorMessage(err)}`,
    );
    return options.fallback;
  }
}

export function writeNamespaceJsonAtomic<T>(
  namespace: string,
  options: WriteNamespaceJsonOptions<T>,
): void {
  const filePath = resolveNamespacePath(namespace, options);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(options.data, null, 2));
    try {
      fs.renameSync(tempPath, filePath);
    } catch (err: unknown) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      } else {
        throw err;
      }
    }
  } catch (err: unknown) {
    options.log?.warn?.(
      `[DingTalk][Persistence] Failed to write namespace=${namespace} path=${filePath}: ${toErrorMessage(err)}`,
    );
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withNamespaceFileLock<T>(
  namespace: string,
  options: ResolveNamespacePathOptions,
  fn: () => T,
): T {
  const filePath = resolveNamespacePath(namespace, options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for persistence lock: ${lockPath}`);
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export function listNamespaceScopeValues(params: {
  namespace: string;
  storePath?: string;
  accountId: string;
  scopeKey: "targetId";
}): string[] {
  if (!params.storePath) {
    return [];
  }
  const baseDir = path.join(path.dirname(params.storePath), NAMESPACE_ROOT_DIR);
  const safeNamespace = sanitizeSegment(params.namespace.trim());
  if (!fs.existsSync(baseDir)) {
    return [];
  }
  const accountMarker = `.account-${encodeScopeValue(params.accountId)}`;
  const scopePrefix = `${safeNamespace}${accountMarker}.`;
  const scopeTokenPrefix = `${params.scopeKey.replace(/Id$/, "")}-`;
  const values = new Set<string>();
  for (const entry of fs.readdirSync(baseDir)) {
    if (!entry.startsWith(scopePrefix) || !entry.endsWith(".json")) {
      continue;
    }
    const segments = entry.slice(safeNamespace.length + 1, -".json".length).split(".");
    for (const segment of segments) {
      if (!segment.startsWith(scopeTokenPrefix)) {
        continue;
      }
      const encoded = segment.slice(scopeTokenPrefix.length);
      if (!encoded) {
        continue;
      }
      try {
        values.add(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch {
        continue;
      }
    }
  }
  return [...values];
}
