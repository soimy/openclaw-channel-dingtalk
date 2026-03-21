import fs from "node:fs";
import path from "node:path";
import { readJsonFile, resolveSessionFilePaths, writeJsonFile, writeTextFile } from "./session-fs.mjs";
import { filterSessionLog } from "./log-filter.mjs";
import { withSessionLock } from "./session-lock.mjs";

const HIGH_LATENCY_THRESHOLD_MS = 30_000;

function readOptionalText(filePath) {
    if (!fs.existsSync(filePath)) {
        return "";
    }
    return fs.readFileSync(filePath, "utf8");
}

function inferLogEvidence(logText) {
    const inboundSeen = ["[inbound]", "handleDingTalkMessage"].some((token) => logText.includes(token));
    const outboundSeen = ["[outbound]", "sendMessage", "sendBySession"].some((token) =>
        logText.includes(token),
    );
    return { inboundSeen, outboundSeen };
}

function computeLatencyMs(observation) {
    if (!observation?.sentAt || !observation?.replyObservedAt) {
        return null;
    }
    const sentAt = Date.parse(observation.sentAt);
    const replyObservedAt = Date.parse(observation.replyObservedAt);
    if (Number.isNaN(sentAt) || Number.isNaN(replyObservedAt)) {
        return null;
    }
    return Math.max(0, replyObservedAt - sentAt);
}

function classifyOutcome({ inboundSeen, outboundSeen, replyObserved, latencyMs }) {
    if (!inboundSeen) {
        return "no_inbound_evidence";
    }
    if (inboundSeen && !outboundSeen) {
        return "inbound_without_outbound";
    }
    if (replyObserved && latencyMs !== null && latencyMs > HIGH_LATENCY_THRESHOLD_MS) {
        return "success_high_latency";
    }
    if (replyObserved) {
        return "end_to_end_success";
    }
    return "outbound_not_visible_in_client";
}

function buildNextAction(outcome) {
    switch (outcome) {
        case "no_inbound_evidence":
            return "Check DingTalk-side delivery, conversation targeting, and whether the probe message was actually sent.";
        case "inbound_without_outbound":
            return "Inspect plugin/runtime processing after inbound delivery and review gateway logs around the trace token.";
        case "outbound_not_visible_in_client":
            return "Compare outbound success logs with DingTalk client visibility and collect more client-side screenshots.";
        case "success_high_latency":
            return "Treat the flow as successful but investigate latency spikes with more timing samples.";
        default:
            return "Session succeeded end-to-end. Archive the artifacts and compare against future regressions.";
    }
}

function buildSummary({ judgment, manifest, timeline, logEvidence }) {
    const latestObservation = manifest.observations.at(-1) ?? null;
    return `# DingTalk Debug Session Summary

## Session Metadata

- Session ID: \`${manifest.sessionId}\`
- Trace Token: \`${manifest.traceToken}\`
- Scenario: \`${manifest.scenario}\`
- Status: \`${manifest.status}\`

## Timeline

${timeline.map((entry) => `- ${entry.at ?? "unknown"} ${entry.type}`).join("\n") || "- (empty)"}

## Probe Results

- connectionCheck: \`${manifest.probes.connectionCheck}\`
- streamMonitor: \`${manifest.probes.streamMonitor}\`
- gatewayRestart: \`${manifest.probes.gatewayRestart}\`
- openclawLogs: \`${manifest.probes.openclawLogs}\`

## Operator Observations

- observationStatus: \`${manifest.operator.observationStatus}\`
- latestReplyStatus: \`${latestObservation?.replyStatus ?? "none"}\`
- latestReplyPreview: \`${latestObservation?.replyPreview ?? ""}\`

## Final Judgment

- outcome: \`${judgment.outcome}\`
- inboundSeen: \`${String(logEvidence.inboundSeen)}\`
- outboundSeen: \`${String(logEvidence.outboundSeen)}\`
- replyObserved: \`${String(judgment.replyObserved)}\`
- latencyMs: \`${judgment.latencyMs ?? ""}\`

## Next Recommended Action

${judgment.nextAction}
`;
}

export async function judgeSession({ sessionDir }) {
    return withSessionLock(sessionDir, "judge", async () => {
        const filePaths = resolveSessionFilePaths(sessionDir);
        const manifest = readJsonFile(filePaths.manifestPath);
        const timeline = readJsonFile(filePaths.timelinePath);
        const filteredLogPath = path.join(sessionDir, "logs", "filtered.log");
        const openclawLogPath = path.join(sessionDir, "logs", "openclaw.log");
        if (!fs.existsSync(filteredLogPath) && fs.existsSync(openclawLogPath)) {
            filterSessionLog({
                sessionDir,
                traceToken: manifest.traceToken,
            });
        }
        const filteredLog = readOptionalText(filteredLogPath);
        const logEvidence = inferLogEvidence(filteredLog);
        const latestObservation = manifest.observations.at(-1) ?? null;
        const replyObserved = latestObservation?.replyStatus === "visible";
        const latencyMs = computeLatencyMs(latestObservation);
        const outcome = classifyOutcome({
            inboundSeen: logEvidence.inboundSeen,
            outboundSeen: logEvidence.outboundSeen,
            replyObserved,
            latencyMs,
        });
        const judgment = {
            outcome,
            inboundSeen: logEvidence.inboundSeen,
            outboundSeen: logEvidence.outboundSeen,
            replyObserved,
            latencyMs,
            nextAction: buildNextAction(outcome),
        };
        const summary = buildSummary({
            judgment,
            manifest,
            timeline,
            logEvidence,
        });

        writeJsonFile(path.join(sessionDir, "judgment.json"), judgment);
        writeTextFile(path.join(sessionDir, "summary.md"), summary);

        return {
            judgment,
            summary,
        };
    });
}

export { HIGH_LATENCY_THRESHOLD_MS };
