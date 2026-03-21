import fs from "node:fs";
import { appendOperatorObservation } from "./operator-contract.mjs";

export function recordObservation({ observationFile, sessionDir }) {
    const observation = JSON.parse(fs.readFileSync(observationFile, "utf8"));
    return appendOperatorObservation(sessionDir, observation);
}
