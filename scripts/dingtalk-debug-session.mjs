#!/usr/bin/env node

import { startSession } from "./real-device-debug/start-session.mjs";
import { prepareSession } from "./real-device-debug/prepare-session.mjs";
import { recordObservation } from "./real-device-debug/record-observation.mjs";
import { judgeSession } from "./real-device-debug/judge-session.mjs";
import { runSession } from "./real-device-debug/run-session.mjs";

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
  node scripts/dingtalk-debug-session.mjs start --scenario <name> --target-id <id> [options]

Options:
  --target-label <label>
  --operator-mode <mode>
  --trace-suffix <suffix>
  --now <iso8601>
  --output-root <dir>

  node scripts/dingtalk-debug-session.mjs prepare --session-dir <dir> [--no-stream-monitor]
  node scripts/dingtalk-debug-session.mjs observe --session-dir <dir> --observation-file <file>
  node scripts/dingtalk-debug-session.mjs judge --session-dir <dir>
  node scripts/dingtalk-debug-session.mjs run --scenario <name> --target-id <id> [options]
`);
}

function hasFlag(args, flag) {
    return args.includes(flag);
}

function runStart(args) {
    const scenario = requireFlag(args, "--scenario");
    const targetId = requireFlag(args, "--target-id");
    const targetLabel = readFlagValue(args, "--target-label");
    const operatorMode = readFlagValue(args, "--operator-mode") || "external";
    const traceSuffix = readFlagValue(args, "--trace-suffix") || undefined;
    const outputRoot = readFlagValue(args, "--output-root") || undefined;
    const nowText = readFlagValue(args, "--now");
    const now = nowText ? new Date(nowText) : new Date();

    if (Number.isNaN(now.getTime())) {
        throw new Error(`Invalid --now value: ${nowText}`);
    }

    const { filePaths, manifest } = startSession({
        now,
        operatorMode,
        outputRoot,
        scenario,
        targetId,
        targetLabel,
        traceSuffix,
    });

    console.log(`sessionId=${manifest.sessionId}`);
    console.log(`traceToken=${manifest.traceToken}`);
    console.log(`sessionDir=${filePaths.sessionDir}`);
    console.log(`manifestPath=${filePaths.manifestPath}`);
    console.log(`operatorStepsPath=${filePaths.operatorStepsPath}`);
}

async function runPrepare(args) {
    const sessionDir = requireFlag(args, "--session-dir");
    const enableStreamMonitor = !hasFlag(args, "--no-stream-monitor");
    const result = await prepareSession({
        sessionDir,
        enableStreamMonitor,
    });

    console.log(`status=${result.manifest.status}`);
    console.log(`nextAction=${result.nextAction}`);
}

function runObserve(args) {
    const sessionDir = requireFlag(args, "--session-dir");
    const observationFile = requireFlag(args, "--observation-file");
    const result = recordObservation({
        observationFile,
        sessionDir,
    });

    console.log(`status=${result.status}`);
    console.log(`observations=${result.manifest.observations.length}`);
}

function runJudge(args) {
    const sessionDir = requireFlag(args, "--session-dir");
    const result = judgeSession({ sessionDir });

    console.log(`outcome=${result.judgment.outcome}`);
    console.log(`nextAction=${result.judgment.nextAction}`);
}

async function runAll(args) {
    const scenario = requireFlag(args, "--scenario");
    const targetId = requireFlag(args, "--target-id");
    const targetLabel = readFlagValue(args, "--target-label");
    const operatorMode = readFlagValue(args, "--operator-mode") || "external";
    const traceSuffix = readFlagValue(args, "--trace-suffix") || undefined;
    const outputRoot = readFlagValue(args, "--output-root") || undefined;
    const nowText = readFlagValue(args, "--now");
    const enableStreamMonitor = !hasFlag(args, "--no-stream-monitor");
    const now = nowText ? new Date(nowText) : new Date();

    if (Number.isNaN(now.getTime())) {
        throw new Error(`Invalid --now value: ${nowText}`);
    }

    const result = await runSession({
        now,
        outputRoot,
        operatorMode,
        scenario,
        targetId,
        targetLabel,
        traceSuffix,
        enableStreamMonitor,
    });

    console.log(`sessionId=${result.manifest.sessionId}`);
    console.log(`traceToken=${result.manifest.traceToken}`);
    console.log(`status=${result.manifest.status}`);
    console.log(`sessionDir=${result.filePaths.sessionDir}`);
    console.log(`nextAction=${result.nextAction}`);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === "--help" || command === "-h") {
        printUsage();
        return;
    }

    if (command === "start") {
        runStart(args.slice(1));
        return;
    }

    if (command === "prepare") {
        await runPrepare(args.slice(1));
        return;
    }

    if (command === "observe") {
        runObserve(args.slice(1));
        return;
    }

    if (command === "judge") {
        runJudge(args.slice(1));
        return;
    }

    if (command === "run") {
        await runAll(args.slice(1));
        return;
    }

    throw new Error(`Unsupported command: ${command}`);
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
