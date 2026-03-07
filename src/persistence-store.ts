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
    .map(([key, value]) => `${key.replace(/Id$/, "")}-${sanitizeSegment((value || "").trim())}`);

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
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(options.data, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (err: unknown) {
    options.log?.warn?.(
      `[DingTalk][Persistence] Failed to write namespace=${namespace} path=${filePath}: ${toErrorMessage(err)}`,
    );
  }
}
