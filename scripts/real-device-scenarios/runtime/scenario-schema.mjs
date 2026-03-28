const ALLOWED_CHANNELS = new Set(["dingtalk"]);
const ALLOWED_TARGET_MODES = new Set(["dm", "group"]);
const ALLOWED_TARGET_RESOLVERS = new Set([
    "latest_inbound_sender",
    "latest_inbound_conversation",
]);

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Scenario field "${label}" must be a non-empty string`);
    }
}

function validateSetup(setup) {
    if (!isObject(setup)) {
        throw new Error('Scenario field "setup" is required');
    }
    for (const key of ["createSession", "restartGateway", "startLogs", "streamMonitor"]) {
        if (typeof setup[key] !== "boolean") {
            throw new Error(`Scenario setup field "${key}" must be boolean`);
        }
    }
}

function validateTarget(target) {
    if (!isObject(target)) {
        throw new Error('Scenario field "target" is required');
    }
    if (!ALLOWED_TARGET_MODES.has(target.mode)) {
        throw new Error('Scenario target field "mode" must be "dm" or "group"');
    }
    if (!ALLOWED_TARGET_RESOLVERS.has(target.resolver)) {
        throw new Error(
            'Scenario target field "resolver" must be one of latest_inbound_sender/latest_inbound_conversation',
        );
    }
}

function validateFixtures(fixtures) {
    if (fixtures === undefined) {
        return;
    }
    if (!isObject(fixtures)) {
        throw new Error('Scenario field "fixtures" must be an object');
    }
    if (fixtures.seedMessages === undefined) {
        return;
    }
    if (!Array.isArray(fixtures.seedMessages)) {
        throw new Error('Scenario field "fixtures.seedMessages" must be an array');
    }
    for (const entry of fixtures.seedMessages) {
        if (!isObject(entry)) {
            throw new Error("Scenario fixture entries must be objects");
        }
        assertNonEmptyString(entry.id, "fixtures.seedMessages[].id");
        if (entry.kind !== "text" && entry.kind !== "file") {
            throw new Error('Scenario fixture field "kind" must be "text" or "file"');
        }
        if (entry.kind === "text") {
            assertNonEmptyString(entry.content, "fixtures.seedMessages[].content");
        }
        if (entry.kind === "file") {
            assertNonEmptyString(entry.filePath, "fixtures.seedMessages[].filePath");
        }
    }
}

function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error('Scenario field "steps" must be a non-empty array');
    }
    for (const step of steps) {
        if (!isObject(step)) {
            throw new Error("Scenario step entries must be objects");
        }
        assertNonEmptyString(step.id, "steps[].id");
        if (step.actor !== "operator" && step.actor !== "harness") {
            throw new Error('Scenario step field "actor" must be "operator" or "harness"');
        }
        assertNonEmptyString(step.kind, "steps[].kind");
    }
}

function validateExpected(expected) {
    if (!isObject(expected)) {
        throw new Error('Scenario field "expected" is required');
    }
    if (typeof expected.replyVisible !== "boolean") {
        throw new Error('Scenario field "expected.replyVisible" must be boolean');
    }
    for (const key of ["replyShouldContain", "replyShouldNotContain", "logSignals"]) {
        if (expected[key] !== undefined && !Array.isArray(expected[key])) {
            throw new Error(`Scenario field "expected.${key}" must be an array when provided`);
        }
    }
}

export function validateScenarioDefinition(candidate) {
    if (!isObject(candidate)) {
        throw new Error("Scenario must be an object");
    }
    assertNonEmptyString(candidate.id, "id");
    assertNonEmptyString(candidate.title, "title");
    assertNonEmptyString(candidate.goal, "goal");
    if (!ALLOWED_CHANNELS.has(candidate.channel)) {
        throw new Error('Scenario field "channel" must be "dingtalk"');
    }
    validateTarget(candidate.target);
    validateSetup(candidate.setup);
    validateFixtures(candidate.fixtures);
    validateSteps(candidate.steps);
    validateExpected(candidate.expected);
    return candidate;
}
