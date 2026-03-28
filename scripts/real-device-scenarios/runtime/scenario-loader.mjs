import quotedAttachmentScenario from "../scenarios/pr389-quoted-attachment.mjs";
import previewStoreMissScenario from "../scenarios/pr389-preview-store-miss.mjs";
import { validateScenarioDefinition } from "./scenario-schema.mjs";

const SCENARIOS = new Map([
    [quotedAttachmentScenario.id, quotedAttachmentScenario],
    [previewStoreMissScenario.id, previewStoreMissScenario],
]);

export function validateScenario(candidate) {
    return validateScenarioDefinition(candidate);
}

export function loadScenario(id) {
    const scenario = SCENARIOS.get(id);
    if (!scenario) {
        throw new Error(`Unknown real-device scenario: ${id}`);
    }
    return validateScenarioDefinition(structuredClone(scenario));
}

export function listScenarioIds() {
    return [...SCENARIOS.keys()].sort();
}
