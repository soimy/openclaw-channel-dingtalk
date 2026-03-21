import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getFixtureById(scenario, fixtureId) {
    const fixtures = scenario.fixtures?.seedMessages ?? [];
    return fixtures.find((entry) => entry.id === fixtureId);
}

function listMessageContextFiles() {
    const agentsRoot = path.join(os.homedir(), ".openclaw", "agents");
    const out = [];

    function walk(dir) {
        if (!fs.existsSync(dir)) {
            return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name.startsWith("messages.context") && entry.name.endsWith(".json")) {
                out.push(fullPath);
            }
        }
    }

    walk(agentsRoot);
    return out;
}

function findLatestMatchingRecord({ conversationId, expectedText }) {
    let bestMatch = null;

    for (const filePath of listMessageContextFiles()) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
            continue;
        }

        const records = parsed.records || {};
        for (const [recordId, record] of Object.entries(records)) {
            if (record?.text !== expectedText) {
                continue;
            }
            if (conversationId && record?.conversationId !== conversationId) {
                continue;
            }

            const createdAt = Number(record?.createdAt ?? 0);
            if (!bestMatch || createdAt > bestMatch.createdAt) {
                bestMatch = {
                    createdAt,
                    filePath,
                    parsed,
                    record,
                    recordId,
                };
            }
        }
    }

    return bestMatch;
}

function ensureBackupDir(sessionDir) {
    const backupDir = path.join(sessionDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    return backupDir;
}

export async function executeHarnessStep({
    sessionDir,
    scenario,
    sessionState,
    step,
}) {
    if (step.kind !== "delete_message_context_record") {
        throw new Error(`Unsupported harness step kind: ${step.kind}`);
    }

    const fixture = getFixtureById(scenario, step.sourceRef);
    if (!fixture || fixture.kind !== "text") {
        throw new Error(`Harness step ${step.id} requires a text fixture sourceRef`);
    }

    const match = findLatestMatchingRecord({
        conversationId: sessionState.target?.conversationId,
        expectedText: fixture.content,
    });
    if (!match) {
        throw new Error(`Unable to find matching messages.context record for fixture ${fixture.id}`);
    }

    const backupDir = ensureBackupDir(sessionDir);
    const backupPath = path.join(backupDir, `${path.basename(match.filePath)}.${match.recordId}.bak`);
    fs.writeFileSync(backupPath, JSON.stringify(match.parsed, null, 2), "utf8");

    delete match.parsed.records[match.recordId];
    fs.writeFileSync(match.filePath, `${JSON.stringify(match.parsed, null, 2)}\n`, "utf8");

    return {
        backupPath,
        filePath: match.filePath,
        recordId: match.recordId,
    };
}
