import { createHash } from "node:crypto";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveNamespacePath } from "../shared/persistence-store";
import type { FeedbackScope } from "./feedback-store";

export function reportPaths(scope: FeedbackScope, cardId: string, destination: string) {
  const base = resolveNamespacePath("feedback.report", {
    storePath: scope.storePath,
    scope: {
      accountId: scope.accountId,
      targetId: createHash("sha256")
        .update(JSON.stringify([destination, cardId]))
        .digest("hex"),
    },
  });
  return { state: base, receipt: base.replace(/\.json$/, ".receipt.json") };
}
export async function readSmallJson<T>(file: string, limit = 64 * 1024): Promise<T | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw e;
  }
  try {
    const sizeHint = (await handle.stat()).size;
    if (sizeHint > limit) {
      throw new Error("metadata_size_limit");
    }
    const buffer = Buffer.alloc(Math.min(limit + 1, sizeHint + 1));
    let size = 0;
    while (size < buffer.length) {
      const r = await handle.read(buffer, size, buffer.length - size, size);
      if (!r.bytesRead) {
        break;
      }
      size += r.bytesRead;
    }
    if (size > limit) {
      throw new Error("metadata_size_limit");
    }
    return JSON.parse(buffer.toString("utf8", 0, size)) as T;
  } finally {
    await handle.close();
  }
}
/** Atomic report state writes, separate from the vote writer. Scheduler receipts are written only after the worker settles. */
export async function writeReportJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // One worker owns this outbox: a fixed exclusive temp name bounds leftovers
  // after foreground cancellation to one per record.
  const tmp = `${file}.tmp`;
  await unlink(tmp).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
  try {
    const h = await open(tmp, "wx", 0o600);
    try {
      await h.writeFile(JSON.stringify(value));
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
