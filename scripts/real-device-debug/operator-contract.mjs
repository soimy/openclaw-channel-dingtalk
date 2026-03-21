import path from "node:path";
import {
    readJsonFile,
    resolveSessionFilePaths,
    writeJsonFile,
    writeTextFile,
} from "./session-fs.mjs";

export function buildProbeMessage(traceToken, scenario) {
    return `/debug ping ${traceToken} scenario=${scenario} 请回复 ok`;
}

export function buildOperatorRequest(manifest) {
    return {
        action: "send_probe_message",
        traceToken: manifest.traceToken,
        targetId: manifest.target.id,
        targetLabel: manifest.target.label || manifest.target.id,
        timeoutSec: 120,
        messageText: buildProbeMessage(manifest.traceToken, manifest.scenario),
        expectedChecks: [
            "message appears in DingTalk conversation",
            "bot reply becomes visible",
        ],
        screenshotTarget: path.posix.join(manifest.artifacts.screenshotsDir, "reply-visible.png"),
    };
}

export function writeOperatorSteps(manifest, operatorStepsPath) {
    const request = buildOperatorRequest(manifest);
    const markdown = `# DingTalk Debug Session Operator Steps

- Session ID: \`${manifest.sessionId}\`
- Trace Token: \`${manifest.traceToken}\`
- Scenario: \`${manifest.scenario}\`
- Target ID: \`${manifest.target.id}\`
- Target Label: \`${manifest.target.label || manifest.target.id}\`
- Timeout: \`${request.timeoutSec}s\`

## Action

1. Open the DingTalk conversation for the target above.
2. Send the following exact probe message:

\`\`\`text
${request.messageText}
\`\`\`

3. Wait up to ${request.timeoutSec} seconds for the bot reply to become visible.
4. If the reply appears, capture a screenshot and place it under:
   \`${request.screenshotTarget}\`
5. If the send fails or the reply never appears, capture the failed state and record the observation later.
`;
    writeTextFile(operatorStepsPath, markdown);
}

function normalizeScreenshotPaths(sessionDir, screenshots = []) {
    return screenshots.map((entry) =>
        path.relative(sessionDir, entry).split(path.sep).join(path.posix.sep),
    );
}

function buildObservationStatus(observation) {
    if (observation.replyStatus === "visible") {
        return "reply_observed";
    }
    if (observation.replyStatus === "timeout") {
        return "timeout";
    }
    if (observation.sendStatus === "sent") {
        return "message_sent";
    }
    return "pending";
}

export function appendOperatorObservation(sessionDir, observation) {
    const filePaths = resolveSessionFilePaths(sessionDir);
    const manifest = readJsonFile(filePaths.manifestPath);
    const timeline = readJsonFile(filePaths.timelinePath);
    const normalizedObservation = {
        ...observation,
        screenshots: normalizeScreenshotPaths(sessionDir, observation.screenshots),
    };
    const status = buildObservationStatus(normalizedObservation);

    manifest.observations = [...manifest.observations, normalizedObservation];
    manifest.operator = {
        ...manifest.operator,
        observationStatus: status,
    };
    manifest.status = status;

    if (normalizedObservation.sendStatus === "sent") {
        timeline.push({
            at: normalizedObservation.sentAt ?? new Date().toISOString(),
            type: "operator.message_sent",
        });
    }
    if (normalizedObservation.replyStatus === "visible") {
        timeline.push({
            at: normalizedObservation.replyObservedAt ?? new Date().toISOString(),
            type: "operator.reply_observed",
        });
    } else if (normalizedObservation.replyStatus === "timeout") {
        timeline.push({
            at: normalizedObservation.replyObservedAt ?? new Date().toISOString(),
            type: "operator.reply_timeout",
        });
    }

    manifest.timeline = timeline;
    writeJsonFile(filePaths.manifestPath, manifest);
    writeJsonFile(filePaths.timelinePath, timeline);

    return {
        manifest,
        observation: normalizedObservation,
        status,
        timeline,
    };
}
