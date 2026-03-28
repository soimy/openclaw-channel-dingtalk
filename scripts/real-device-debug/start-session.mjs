import { createInitialManifest } from "./session-contract.mjs";
import { writeOperatorSteps } from "./operator-contract.mjs";
import {
    ensureDir,
    resolveSessionFilePaths,
    writeJsonFile,
} from "./session-fs.mjs";
import { createInitialTimeline } from "./timeline.mjs";

export function startSession({
    now = new Date(),
    outputRoot,
    operatorMode = "external",
    scenario,
    targetId,
    targetLabel = "",
    traceSuffix,
}) {
    const manifest = createInitialManifest({
        now,
        outputRoot,
        operatorMode,
        scenario,
        targetId,
        targetLabel,
        traceSuffix,
    });
    const timeline = createInitialTimeline();
    const filePaths = resolveSessionFilePaths(manifest.artifacts.rootDir);

    ensureDir(manifest.artifacts.rootDir);
    ensureDir(manifest.artifacts.logsDir);
    ensureDir(manifest.artifacts.screenshotsDir);

    writeJsonFile(filePaths.manifestPath, manifest);
    writeJsonFile(filePaths.timelinePath, timeline);
    writeOperatorSteps(manifest, filePaths.operatorStepsPath);

    return {
        filePaths,
        manifest,
        timeline,
    };
}
