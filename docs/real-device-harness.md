# Scenario-Driven Real-Device Harness

Chinese version: [`real-device-harness.zh-CN.md`](real-device-harness.zh-CN.md)

This document describes the scenario-driven real-device verification harness for the DingTalk channel plugin.

It complements the existing low-level `debug:session` workflow by adding:

- versioned scenario definitions
- a standard operator prompt / input / observation interface
- resumable multi-phase execution
- target resolution that does not hardcode one user or one group

## Why This Exists

The repository already has `pnpm debug:session ...`, which is useful as a low-level real-device primitive:

- start a session
- prepare probes
- record observations
- judge the session

That works well when a developer is actively steering the session.

But once a team wants to turn real-device checks into reusable test assets, `debug:session` alone is not enough. We also need:

- a way to define the scenario itself in version control
- a way to generate a stable prompt for humans or desktop-capable agents
- a way to pause and resume a scenario without relying on chat memory

That is the role of the scenario-driven harness.

## Relationship To `debug:session`

Use these two layers differently:

### `pnpm debug:session`

This is the low-level primitive layer.

Use it when:

- you need ad-hoc investigation
- you are manually steering a one-off debug session
- you want direct control over `start`, `prepare`, `observe`, or `judge`

### `pnpm real-device:verify`

This is the high-level scenario layer.

Use it when:

- you want a repeatable real-device test for a PR or commit
- you want the repository to generate the operator prompt for you
- you want to hand the client-side steps to a human or a desktop agent
- you want the test scenario itself to live in version control

In short:

- `debug:session` = primitive
- `real-device:verify` = scenario orchestrator

## Current Scope

The current implementation is intentionally narrow:

- DingTalk only
- initial scenario schema
- prompt and template generation
- resumable phase machine
- target resolution for DM / group scenarios
- bridge into existing `prepareSession`, `recordObservation`, and `judgeSession`

It is not yet a full end-to-end harness for every scenario, and it does not drive DingTalk UI directly.

## Files And Responsibilities

### Scenario Definitions

Located under:

```text
scripts/real-device-scenarios/scenarios/
```

Examples:

- `pr389-quoted-attachment.mjs`
- `pr389-preview-store-miss.mjs`

Each scenario defines:

- what is being tested
- target requirements
- fixtures
- ordered steps
- expected result
- cleanup hints

### Runtime Layer

Located under:

```text
scripts/real-device-scenarios/runtime/
```

Key modules:

- `scenario-loader.mjs`
- `prompt-renderer.mjs`
- `phase-machine.mjs`
- `target-resolver.mjs`
- `operator-io.mjs`
- `verify.mjs`

### Tests

Located under:

```text
tests/unit/real-device-scenarios/
tests/integration/real-device-scenarios/
```

These tests validate schema, rendering, phase transitions, target resolution, and the runner shell itself.

## Basic Command Flow

### Start A Scenario

```bash
pnpm real-device:verify --scenario pr389-preview-store-miss
```

This command creates a run package and exits in a waiting state.

Depending on what is known, it may generate:

- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`

or:

- `operator-prompt.md`
- `operator-input.json`
- `operator-response.template.json`
- `observation.template.json`

### Resume A Scenario

```bash
pnpm real-device:verify --resume <sessionDir>
```

This command reads the current `session.json` phase and advances the scenario when enough input is available.

In the current public CLI, `--resume` may stop at:

- `WAITING_FOR_TARGET`
- `WAITING_FOR_OPERATOR`
- `WAITING_FOR_OBSERVATION`
- `READY_FOR_JUDGING`

Programmatic flows also support an internal `autoJudge` bridge after observation is recorded.

## Standardized Run Package

The harness writes a standardized package under the scenario session directory.

Common files:

- `session.json`
- `scenario.snapshot.json`
- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`
- `resolve-target.response.json`
- `operator-prompt.md`
- `operator-input.json`
- `operator-response.template.json`
- `operator-response.json`
- `observation.template.json`
- `observation.json`

This package is intended to be handed to:

- a human operator
- a desktop-capable agent
- future automation adapters

Current handoff meanings:

- `resolve-target.response.json`: manual target resolution result when auto resolution is insufficient
- `operator-response.json`: per-step completion signal for operator actions
- `observation.json`: final observation handoff that advances the run into judging

## Target Resolution

Targets must not be hardcoded to one user or one group.

The harness resolves them dynamically using this priority:

1. latest inbound context
2. `resolve-target.response.json`
3. learned local `targets.directory`
4. explicit override

If none of these work, the session stays in `resolve_target`.

## Adding A New Scenario

When adding a scenario:

1. Create a new scenario file under `scripts/real-device-scenarios/scenarios/`
2. Keep the scenario declarative
3. Prefer reusing existing low-level debug-session capabilities
4. Add focused tests for loader / renderer / phase flow if the scenario shape introduces anything new

Keep the scenario focused on one user-visible hypothesis.

Good examples:

- quoted attachment should become `ReplyToBody`
- preview fallback should work when store miss happens

Avoid combining multiple unrelated hypotheses in one scenario.

## Current Recommendation

For day-to-day development:

- use `pnpm real-device:verify ...` when you want a reusable, versioned scenario
- use `pnpm debug:session ...` when you need low-level manual control

## Related Docs

- [`docs/real-device-debugging.md`](real-device-debugging.md)
- [`docs/real-device-debugging.zh-CN.md`](real-device-debugging.zh-CN.md)
- [`docs/designs/2026-03-21-scenario-driven-real-device-harness-design.md`](designs/2026-03-21-scenario-driven-real-device-harness-design.md)
- [`docs/implementation-plans/2026-03-21-scenario-driven-real-device-harness-implementation.md`](implementation-plans/2026-03-21-scenario-driven-real-device-harness-implementation.md)
