import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLockPaths(sessionDir) {
    const lockDir = path.join(sessionDir, ".session.lock");
    return {
        lockDir,
        metadataPath: path.join(lockDir, "metadata.json"),
    };
}

async function acquireSessionLock(sessionDir, owner, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    const { lockDir, metadataPath } = buildLockPaths(sessionDir);

    while (true) {
        try {
            fs.mkdirSync(lockDir);
            fs.writeFileSync(
                metadataPath,
                `${JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
                "utf8",
            );
            return { lockDir };
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
                if (Date.now() - startedAt >= timeoutMs) {
                    let details = "";
                    try {
                        details = fs.readFileSync(metadataPath, "utf8").trim();
                    } catch {
                        details = "";
                    }
                    throw new Error(
                        `Timed out waiting for debug session lock in ${sessionDir}${details ? ` (${details})` : ""}`,
                    );
                }
                await sleep(DEFAULT_POLL_MS);
                continue;
            }
            throw error;
        }
    }
}

function releaseSessionLock(lockHandle) {
    fs.rmSync(lockHandle.lockDir, { recursive: true, force: true });
}

export async function withSessionLock(sessionDir, owner, fn, options = {}) {
    const lockHandle = await acquireSessionLock(sessionDir, owner, options.timeoutMs);
    try {
        return await fn();
    } finally {
        releaseSessionLock(lockHandle);
    }
}
