#!/usr/bin/env node

import path from "node:path";
import {
    createInitialManifest,
    DEFAULT_OUTPUT_ROOT,
} from "../../real-device-debug/session-contract.mjs";
import { createInitialTimeline } from "../../real-device-debug/timeline.mjs";
import { writeJsonFile } from "../../real-device-debug/session-fs.mjs";
import { prepareSession } from "../../real-device-debug/prepare-session.mjs";
import { judgeSession } from "../../real-device-debug/judge-session.mjs";
import { recordObservation } from "../../real-device-debug/record-observation.mjs";
import { loadScenario, validateScenario } from "./scenario-loader.mjs";
import {
    ensureVerifyDirectories,
    readOptionalJson,
    readScenarioSnapshot,
    readVerifyState,
    resolveVerifyFilePaths,
    writeOperatorPackage,
    writeResolveTargetPackage,
    writeScenarioSnapshot,
    writeVerifyState,
} from "./operator-io.mjs";
import {
    renderObservationTemplate,
    renderOperatorInput,
    renderOperatorPrompt,
    renderResolveTargetInput,
    renderResolveTargetPrompt,
    renderResolveTargetResponseTemplate,
} from "./prompt-renderer.mjs";
import { createInitialPhaseState, resolveNextPhase } from "./phase-machine.mjs";
import { resolveTarget } from "./target-resolver.mjs";

const DEFAULT_VERIFY_OUTPUT_ROOT = ".local/real-device-runs";

function getDefaultDependencies() {
    return {
        judgeSession,
        prepareSession,
        recordObservation,
    };
}

function readFlagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index < 0) {
        return "";
    }
    return String(args[index + 1] ?? "").trim();
}

function requireFlag(args, flag) {
    const value = readFlagValue(args, flag);
    if (!value) {
        throw new Error(`Missing required argument: ${flag}`);
    }
    return value;
}

function printUsage() {
    console.log(`Usage:
  node scripts/real-device-scenarios/runtime/verify.mjs --scenario <id> [options]
  node scripts/real-device-scenarios/runtime/verify.mjs --resume <sessionDir>

Options:
  --output-root <dir>
  --now <iso8601>
  --trace-suffix <suffix>
  --target-id <id>
  --target-label <label>
`);
}

function buildSessionState({ manifest, phaseState, scenario }) {
    return {
        phase: phaseState.phase,
        status: phaseState.status,
        sessionId: manifest.sessionId,
        scenarioId: scenario.id,
        traceToken: manifest.traceToken,
        resumeCommand: phaseState.resumeCommand,
        target: {
            id: manifest.target.id,
            label: manifest.target.label,
            mode: scenario.target.mode,
        },
        completedSteps: [],
    };
}

function renderResolveTargetPackage({ filePaths, manifest, scenario }) {
    writeResolveTargetPackage(filePaths, {
        prompt: renderResolveTargetPrompt({ manifest, scenario }),
        input: renderResolveTargetInput({ manifest, scenario }),
        template: renderResolveTargetResponseTemplate({ manifest, scenario }),
    });
}

function renderOperatorActionPackage({ filePaths, manifest, scenario }) {
    writeOperatorPackage(filePaths, {
        prompt: renderOperatorPrompt({ manifest, scenario }),
        input: renderOperatorInput({ manifest, scenario }),
        template: renderObservationTemplate({ manifest, scenario }),
    });
}

export async function startScenarioWithDependencies({
    dependencies = {},
    now = new Date(),
    outputRoot = DEFAULT_VERIFY_OUTPUT_ROOT,
    scenario,
    targetId = "",
    targetLabel = "",
    traceSuffix,
}) {
    const resolvedDependencies = {
        ...getDefaultDependencies(),
        ...dependencies,
    };

    let manifest = createInitialManifest({
        now,
        scenario: scenario.id,
        targetId,
        targetLabel,
        traceSuffix,
        outputRoot,
    });
    const timeline = createInitialTimeline();
    const filePaths = resolveVerifyFilePaths(manifest.artifacts.rootDir);
    const phaseState = createInitialPhaseState({ manifest, scenario });
    const sessionState = buildSessionState({ manifest, phaseState, scenario });

    ensureVerifyDirectories(manifest);
    writeJsonFile(filePaths.manifestPath, manifest);
    writeJsonFile(filePaths.timelinePath, timeline);
    writeVerifyState(filePaths, sessionState);
    writeScenarioSnapshot(filePaths, scenario);

    if (phaseState.phase === "resolve_target") {
        renderResolveTargetPackage({ filePaths, manifest, scenario });
        return {
            filePaths,
            manifest,
            sessionState,
            stdoutLines: [
                "WAITING_FOR_TARGET",
                `sessionDir=${filePaths.sessionDir}`,
                `sessionId=${manifest.sessionId}`,
            ],
        };
    }

    const prepareResult = await resolvedDependencies.prepareSession({
        enableStreamMonitor: false,
        runner: undefined,
        sessionDir: filePaths.sessionDir,
    });
    manifest = {
        ...manifest,
        ...prepareResult.manifest,
    };
    writeJsonFile(filePaths.manifestPath, manifest);

    const nextState = resolveNextPhase({
        phase: "setup",
        scenario,
    });
    const updatedSessionState = {
        ...sessionState,
        phase: nextState.phase,
        status: nextState.status,
        target: {
            ...sessionState.target,
        },
    };
    writeVerifyState(filePaths, updatedSessionState);
    renderOperatorActionPackage({ filePaths, manifest, scenario });
    return {
        filePaths,
        manifest,
        sessionState: updatedSessionState,
        stdoutLines: [
            "WAITING_FOR_OPERATOR",
            `sessionDir=${filePaths.sessionDir}`,
            `sessionId=${manifest.sessionId}`,
        ],
    };
}

export async function resumeScenarioWithDependencies({
    dependencies = {},
    sessionDir,
    autoJudge = false,
}) {
    const resolvedDependencies = {
        ...getDefaultDependencies(),
        ...dependencies,
    };
    const filePaths = resolveVerifyFilePaths(sessionDir);
    const sessionState = readVerifyState(filePaths);
    const scenario = validateScenario(readScenarioSnapshot(filePaths));
    const manifest = readOptionalJson(filePaths.manifestPath) ?? {
        target: {
            id: sessionState.target?.id ?? "",
            label: sessionState.target?.label ?? "",
        },
        artifacts: {
            rootDir: sessionDir,
        },
    };

    if (sessionState.phase === "resolve_target") {
        const resolveTargetResponse = readOptionalJson(filePaths.resolveTargetResponsePath);
        const resolved = resolveTarget({
            scenario,
            resolveTargetResponse,
        });

        if (resolved.status !== "resolved") {
            renderResolveTargetPackage({ filePaths, manifest, scenario });
            return {
                filePaths,
                manifest,
                sessionState,
                stdoutLines: ["WAITING_FOR_TARGET", `sessionDir=${filePaths.sessionDir}`],
            };
        }

        const updatedManifest = {
            ...manifest,
            target: {
                id: resolved.target.id,
                label: resolved.target.label,
            },
        };
        writeJsonFile(filePaths.manifestPath, updatedManifest);

        const prepareResult = await resolvedDependencies.prepareSession({
            enableStreamMonitor: false,
            runner: undefined,
            sessionDir: filePaths.sessionDir,
        });
        const preparedManifest = {
            ...updatedManifest,
            ...prepareResult.manifest,
        };
        writeJsonFile(filePaths.manifestPath, preparedManifest);

        const nextState = resolveNextPhase({
            phase: "setup",
            scenario,
        });
        const updatedSessionState = {
            ...sessionState,
            phase: nextState.phase,
            status: nextState.status,
            target: resolved.target,
        };
        writeVerifyState(filePaths, updatedSessionState);
        renderOperatorActionPackage({ filePaths, manifest: preparedManifest, scenario });
        return {
            filePaths,
            manifest: preparedManifest,
            sessionState: updatedSessionState,
            stdoutLines: ["WAITING_FOR_OPERATOR", `sessionDir=${filePaths.sessionDir}`],
        };
    }

    if (sessionState.phase === "waiting_for_observation") {
        const observation = readOptionalJson(filePaths.observationPath);
        if (observation?.status === "completed") {
            await resolvedDependencies.recordObservation({
                observationFile: filePaths.observationPath,
                sessionDir,
            });
        }
        const nextState = resolveNextPhase({
            phase: "waiting_for_observation",
            scenario,
            observationCompleted: observation?.status === "completed",
        });
        const updatedSessionState = {
            ...sessionState,
            phase: nextState.phase,
            status: nextState.status,
        };
        writeVerifyState(filePaths, updatedSessionState);
        if (nextState.phase === "judging" && autoJudge) {
            await resolvedDependencies.judgeSession({ sessionDir });
            const completedState = {
                ...updatedSessionState,
                phase: "completed",
                status: "completed",
            };
            writeVerifyState(filePaths, completedState);
            return {
                filePaths,
                manifest,
                sessionState: completedState,
                stdoutLines: ["COMPLETED", `sessionDir=${filePaths.sessionDir}`],
            };
        }

        return {
            filePaths,
            manifest,
            sessionState: updatedSessionState,
            stdoutLines: [
                nextState.phase === "judging" ? "READY_FOR_JUDGING" : "WAITING_FOR_OBSERVATION",
                `sessionDir=${filePaths.sessionDir}`,
            ],
        };
    }

    return {
        filePaths,
        manifest,
        sessionState,
        stdoutLines: [`NO_OP phase=${sessionState.phase}`, `sessionDir=${filePaths.sessionDir}`],
    };
}

async function startScenario(args) {
    const scenario = loadScenario(requireFlag(args, "--scenario"));
    const outputRoot = readFlagValue(args, "--output-root") || DEFAULT_VERIFY_OUTPUT_ROOT;
    const targetId = readFlagValue(args, "--target-id");
    const targetLabel = readFlagValue(args, "--target-label");
    const traceSuffix = readFlagValue(args, "--trace-suffix") || undefined;
    const nowText = readFlagValue(args, "--now");
    const now = nowText ? new Date(nowText) : new Date();

    if (Number.isNaN(now.getTime())) {
        throw new Error(`Invalid --now value: ${nowText}`);
    }

    const result = await startScenarioWithDependencies({
        now,
        outputRoot,
        scenario,
        targetId,
        targetLabel,
        traceSuffix,
    });
    for (const line of result.stdoutLines) {
        console.log(line);
    }
}

async function resumeScenario(args) {
    const sessionDir = requireFlag(args, "--resume");
    const result = await resumeScenarioWithDependencies({
        sessionDir,
    });
    for (const line of result.stdoutLines) {
        console.log(line);
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }

    if (args.includes("--scenario")) {
        await startScenario(args);
        return;
    }

    if (args.includes("--resume")) {
        await resumeScenario(args);
        return;
    }

    throw new Error("Either --scenario or --resume is required");
}

function isDirectExecution() {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
}

if (isDirectExecution()) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

export { DEFAULT_VERIFY_OUTPUT_ROOT };
