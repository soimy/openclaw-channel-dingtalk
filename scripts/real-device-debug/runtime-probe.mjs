import path from "node:path";
import { createShellProcessRunner } from "./process-runner.mjs";

function cloneManifest(manifest) {
    return {
        ...manifest,
        operator: { ...manifest.operator },
        probes: { ...manifest.probes },
        target: { ...manifest.target },
        artifacts: { ...manifest.artifacts },
        observations: [...manifest.observations],
        timeline: [...manifest.timeline],
    };
}

function appendTimeline(timeline, type) {
    timeline.push({
        at: new Date().toISOString(),
        type,
    });
}

export async function runPreflightAndCapture({
    manifest,
    runner = createShellProcessRunner(),
    sessionDir,
    enableStreamMonitor = true,
}) {
    const nextManifest = cloneManifest(manifest);
    const timeline = [];
    const logsDir = path.join(sessionDir, "logs");

    await runner.run("bash scripts/dingtalk-connection-check.sh", path.join(logsDir, "connection-check.log"));
    nextManifest.probes.connectionCheck = "ok";
    appendTimeline(timeline, "probe.connection_check.ok");

    if (enableStreamMonitor) {
        await runner.run(
            "node scripts/dingtalk-stream-monitor.mjs --duration 20",
            path.join(logsDir, "stream-monitor.log"),
        );
        nextManifest.probes.streamMonitor = "ok";
        appendTimeline(timeline, "probe.stream_monitor.ok");
    } else {
        nextManifest.probes.streamMonitor = "skipped";
        appendTimeline(timeline, "probe.stream_monitor.skipped");
    }

    await runner.run("openclaw gateway restart", path.join(logsDir, "gateway-restart.log"));
    nextManifest.probes.gatewayRestart = "ok";
    appendTimeline(timeline, "probe.gateway_restart.ok");

    const logCapture = await runner.start("openclaw logs", path.join(logsDir, "openclaw.log"));
    nextManifest.probes.openclawLogs = "running";
    nextManifest.status = "probes_running";
    nextManifest.processes = {
        openclawLogs: {
            pid: logCapture.pid,
        },
    };
    appendTimeline(timeline, "probe.openclaw_logs.running");

    nextManifest.timeline = timeline;
    return {
        manifest: nextManifest,
        timeline,
    };
}
