import path from "node:path";
import { readJsonFile, resolveSessionFilePaths, writeJsonFile } from "./session-fs.mjs";
import { runPreflightAndCapture } from "./runtime-probe.mjs";
import { withSessionLock } from "./session-lock.mjs";

function buildNextAction(manifest) {
    const screenshotPath = path.posix.join(manifest.artifacts.screenshotsDir, "reply-visible.png");
    return [
        `Send the probe message containing ${manifest.traceToken}.`,
        `Wait up to 120 seconds for the reply to become visible.`,
        `If visible, save a screenshot under ${screenshotPath}.`,
    ].join(" ");
}

export async function prepareSession({ sessionDir, runner, enableStreamMonitor = true }) {
    return withSessionLock(sessionDir, "prepare", async () => {
        const filePaths = resolveSessionFilePaths(sessionDir);
        const manifest = readJsonFile(filePaths.manifestPath);
        const result = await runPreflightAndCapture({
            manifest,
            runner,
            sessionDir,
            enableStreamMonitor,
        });

        writeJsonFile(filePaths.manifestPath, result.manifest);
        writeJsonFile(filePaths.timelinePath, result.timeline);

        return {
            ...result,
            nextAction: buildNextAction(result.manifest),
        };
    });
}
