import fs from "node:fs";
import path from "node:path";

function buildNeedles({ manifest, scenario }) {
    return [
        manifest.traceToken,
        ...(scenario.expected?.logSignals ?? []),
        ...(scenario.expected?.replyShouldContain ?? []),
    ].filter(Boolean);
}

export function collectScenarioEvidence({ gatewayLogPath, manifest, scenario }) {
    const raw = fs.existsSync(gatewayLogPath) ? fs.readFileSync(gatewayLogPath, "utf8") : "";
    const needles = buildNeedles({ manifest, scenario });
    const lines = raw.split(/\r?\n/);
    const keep = new Set();

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line || !needles.some((needle) => line.includes(needle))) {
            continue;
        }
        for (let cursor = Math.max(0, i - 1); cursor <= Math.min(lines.length - 1, i + 1); cursor += 1) {
            if (lines[cursor]) {
                keep.add(cursor);
            }
        }
    }

    return [...keep]
        .sort((a, b) => a - b)
        .map((index) => lines[index])
        .join("\n");
}

export function buildScenarioEvidenceLog({ gatewayLogPath, manifest, scenario }) {
    const logsDir = path.join(manifest.artifacts.rootDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const filteredLogPath = path.join(logsDir, "filtered.log");
    const collected = collectScenarioEvidence({ gatewayLogPath, manifest, scenario });
    fs.writeFileSync(filteredLogPath, collected ? `${collected}\n` : "", "utf8");
    return filteredLogPath;
}
