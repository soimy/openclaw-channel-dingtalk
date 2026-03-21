import fs from "node:fs";
import { appendOperatorObservation } from "./operator-contract.mjs";
import { withSessionLock } from "./session-lock.mjs";

export async function recordObservation({ observationFile, sessionDir }) {
    return withSessionLock(sessionDir, "observe", async () => {
        const observation = JSON.parse(fs.readFileSync(observationFile, "utf8"));
        return appendOperatorObservation(sessionDir, observation);
    });
}
