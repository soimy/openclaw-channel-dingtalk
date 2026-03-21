import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_OUTPUT_ROOT = ".local/debug-sessions";

function pad(value) {
    return String(value).padStart(2, "0");
}

function formatUtcDate(now) {
    return [
        now.getUTCFullYear(),
        pad(now.getUTCMonth() + 1),
        pad(now.getUTCDate()),
    ].join("");
}

function formatUtcClock(now) {
    return [pad(now.getUTCHours()), pad(now.getUTCMinutes()), pad(now.getUTCSeconds())].join("");
}

function formatUtcDayPath(now) {
    return [now.getUTCFullYear(), pad(now.getUTCMonth() + 1), pad(now.getUTCDate())].join("-");
}

function sanitizeScenario(value) {
    return String(value).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function randomTraceSuffix() {
    return crypto.randomBytes(2).toString("hex").toUpperCase();
}

function parseDayPathFromSessionId(sessionId) {
    const match = /^dtdbg-(\d{4})(\d{2})(\d{2})-\d{6}-/.exec(sessionId);
    if (!match) {
        throw new Error(`Invalid debug session id: ${sessionId}`);
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
}

export function buildTraceToken(now, suffix = randomTraceSuffix()) {
    return `DTDBG-${formatUtcDate(now)}-${formatUtcClock(now)}-${String(suffix).toUpperCase()}`;
}

export function buildSessionId(now, scenario) {
    const normalizedScenario = sanitizeScenario(scenario);
    return `dtdbg-${formatUtcDate(now)}-${formatUtcClock(now)}-${normalizedScenario}`;
}

export function buildSessionArtifacts(sessionId, outputRoot = DEFAULT_OUTPUT_ROOT) {
    const dayPath = parseDayPathFromSessionId(sessionId);
    const rootDir = path.posix.join(outputRoot, dayPath, sessionId);
    return {
        rootDir,
        logsDir: path.posix.join(rootDir, "logs"),
        screenshotsDir: path.posix.join(rootDir, "screenshots"),
    };
}

export function createInitialManifest({
    now = new Date(),
    scenario,
    targetId,
    targetLabel = "",
    traceSuffix,
    operatorMode = "external",
    outputRoot = DEFAULT_OUTPUT_ROOT,
}) {
    const sessionId = buildSessionId(now, scenario);
    const traceToken = buildTraceToken(now, traceSuffix);
    const artifacts = buildSessionArtifacts(sessionId, outputRoot);

    return {
        version: 1,
        sessionId,
        traceToken,
        createdAt: now.toISOString(),
        status: "created",
        scenario: sanitizeScenario(scenario),
        target: {
            id: targetId,
            label: targetLabel,
        },
        operator: {
            mode: operatorMode,
            observationStatus: "pending",
        },
        probes: {
            connectionCheck: "pending",
            streamMonitor: "pending",
            gatewayRestart: "pending",
            openclawLogs: "pending",
        },
        artifacts,
        timeline: [],
        observations: [],
        nextAction: "prepare",
    };
}

export { DEFAULT_OUTPUT_ROOT };
