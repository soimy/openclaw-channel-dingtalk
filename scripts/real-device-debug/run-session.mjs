import { startSession } from "./start-session.mjs";
import { prepareSession } from "./prepare-session.mjs";

export async function runSession({
    now = new Date(),
    outputRoot,
    operatorMode = "external",
    scenario,
    targetId,
    targetLabel = "",
    traceSuffix,
    enableStreamMonitor = true,
    runner,
}) {
    const started = startSession({
        now,
        outputRoot,
        operatorMode,
        scenario,
        targetId,
        targetLabel,
        traceSuffix,
    });
    const prepared = await prepareSession({
        sessionDir: started.filePaths.sessionDir,
        runner,
        enableStreamMonitor,
    });

    return {
        ...prepared,
        filePaths: started.filePaths,
    };
}
