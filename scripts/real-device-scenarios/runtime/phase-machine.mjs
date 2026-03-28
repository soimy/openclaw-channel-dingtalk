function buildResumeCommand(manifest) {
    return `pnpm real-device:verify --resume ${manifest.artifacts.rootDir}`;
}

function hasResolvedTarget(manifest) {
    return Boolean(String(manifest.target?.id || "").trim());
}

function isStepCompleted(stepId, completedSteps = [], currentCompletedStep) {
    return completedSteps.includes(stepId) || currentCompletedStep === stepId;
}

function getNextPendingStep(scenario, completedSteps = [], currentCompletedStep) {
    return scenario.steps.find(
        (step) => !isStepCompleted(step.id, completedSteps, currentCompletedStep),
    );
}

export function createInitialPhaseState({ manifest, scenario }) {
    if (!hasResolvedTarget(manifest)) {
        return {
            phase: "resolve_target",
            status: "blocked_on_target_resolution",
            resumeCommand: buildResumeCommand(manifest),
        };
    }

    return {
        phase: "setup",
        status: "ready_for_setup",
        resumeCommand: buildResumeCommand(manifest),
    };
}

export function getCurrentOperatorStep({ phase, scenario, completedSteps = [] }) {
    if (phase !== "operator_action") {
        return undefined;
    }
    const nextPendingStep = getNextPendingStep(scenario, completedSteps);
    return nextPendingStep?.actor === "operator" ? nextPendingStep : undefined;
}

export function resolveNextPhase({
    phase,
    scenario,
    completedSteps = [],
    operatorStepCompleted,
    harnessStepCompleted,
    observationCompleted = false,
}) {
    if (phase === "setup") {
        return {
            phase: "operator_action",
            status: "blocked_on_operator",
        };
    }

    if (phase === "operator_action") {
        const nextPendingStep = getNextPendingStep(scenario, completedSteps, operatorStepCompleted);
        if (!nextPendingStep) {
            return {
                phase: "waiting_for_observation",
                status: "blocked_on_observation",
            };
        }

        if (nextPendingStep.actor === "operator") {
            return {
                phase: "operator_action",
                status: "blocked_on_operator",
            };
        }

        if (nextPendingStep.actor === "harness") {
            return {
                phase: "harness_action",
                status: "ready_for_harness_step",
                nextHarnessStepId: nextPendingStep.id,
            };
        }
    }

    if (phase === "harness_action") {
        const nextPendingStep = getNextPendingStep(scenario, completedSteps, harnessStepCompleted);
        if (!nextPendingStep) {
            return {
                phase: "waiting_for_observation",
                status: "blocked_on_observation",
            };
        }

        if (nextPendingStep.actor === "harness") {
            return {
                phase: "harness_action",
                status: "ready_for_harness_step",
                nextHarnessStepId: nextPendingStep.id,
            };
        }

        if (nextPendingStep.actor === "operator") {
            return {
                phase: "operator_action",
                status: "blocked_on_operator",
            };
        }
    }

    if (phase === "waiting_for_observation") {
        if (observationCompleted) {
            return {
                phase: "judging",
                status: "ready_for_judging",
            };
        }
        return {
            phase: "waiting_for_observation",
            status: "blocked_on_observation",
        };
    }

    if (phase === "judging") {
        return {
            phase: "completed",
            status: "completed",
        };
    }

    return {
        phase,
        status: "unknown",
    };
}
