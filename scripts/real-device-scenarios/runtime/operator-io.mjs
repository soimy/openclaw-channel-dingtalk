import path from "node:path";
import {
    ensureDir,
    readJsonFile,
    writeJsonFile,
    writeTextFile,
} from "../../real-device-debug/session-fs.mjs";

export function resolveVerifyFilePaths(sessionDir) {
    return {
        sessionDir,
        sessionStatePath: path.join(sessionDir, "session.json"),
        scenarioSnapshotPath: path.join(sessionDir, "scenario.snapshot.json"),
        resolveTargetPromptPath: path.join(sessionDir, "resolve-target-prompt.md"),
        resolveTargetInputPath: path.join(sessionDir, "resolve-target.input.json"),
        resolveTargetResponseTemplatePath: path.join(sessionDir, "resolve-target.response.template.json"),
        resolveTargetResponsePath: path.join(sessionDir, "resolve-target.response.json"),
        operatorPromptPath: path.join(sessionDir, "operator-prompt.md"),
        operatorInputPath: path.join(sessionDir, "operator-input.json"),
        operatorResponseTemplatePath: path.join(sessionDir, "operator-response.template.json"),
        operatorResponsePath: path.join(sessionDir, "operator-response.json"),
        observationTemplatePath: path.join(sessionDir, "observation.template.json"),
        observationPath: path.join(sessionDir, "observation.json"),
        manifestPath: path.join(sessionDir, "manifest.json"),
        timelinePath: path.join(sessionDir, "timeline.json"),
    };
}

export function ensureVerifyDirectories(manifest) {
    ensureDir(manifest.artifacts.rootDir);
    ensureDir(manifest.artifacts.logsDir);
    ensureDir(manifest.artifacts.screenshotsDir);
}

export function writeVerifyState(filePaths, sessionState) {
    writeJsonFile(filePaths.sessionStatePath, sessionState);
}

export function writeScenarioSnapshot(filePaths, scenario) {
    writeJsonFile(filePaths.scenarioSnapshotPath, scenario);
}

export function writeResolveTargetPackage(filePaths, rendered) {
    writeTextFile(filePaths.resolveTargetPromptPath, rendered.prompt);
    writeJsonFile(filePaths.resolveTargetInputPath, rendered.input);
    writeJsonFile(filePaths.resolveTargetResponseTemplatePath, rendered.template);
}

export function writeOperatorPackage(filePaths, rendered) {
    writeTextFile(filePaths.operatorPromptPath, rendered.prompt);
    writeJsonFile(filePaths.operatorInputPath, rendered.input);
    writeJsonFile(filePaths.operatorResponseTemplatePath, rendered.responseTemplate);
    writeJsonFile(filePaths.observationTemplatePath, rendered.template);
}

export function readVerifyState(filePaths) {
    return readJsonFile(filePaths.sessionStatePath);
}

export function readScenarioSnapshot(filePaths) {
    return readJsonFile(filePaths.scenarioSnapshotPath);
}

export function readOptionalJson(filePath) {
    try {
        return readJsonFile(filePath);
    } catch {
        return undefined;
    }
}
