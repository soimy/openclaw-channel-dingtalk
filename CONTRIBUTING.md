# Contributing to OpenClaw DingTalk Channel

中文版请见：[`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)

Thanks for helping improve the DingTalk channel plugin for OpenClaw.

This repository has a few areas that need extra care when you change them:

- Stream-mode connection lifecycle and inbound callback handling
- Memory-only runtime state such as `dedup.processed-message`, `session.lock`, and `channel.inflight`
- Quoted message recovery across text, media, file, and AI card flows
- DingTalk platform behavior that can vary by tenant, app permissions, and `dingtalk-stream` version

Use this guide as the contributor entry point, then follow the deeper links in `README.md` and `docs/` for platform-specific details.

## Documentation Placement Rules

Keep documentation updates structured:

- `README.md` is a concise repository entry page only. Do not keep extending it with long feature manuals, config matrices, troubleshooting deep dives, or release-history details.
- User-facing setup, behavior, and troubleshooting updates belong under `docs/user/`.
- Contributor, architecture, testing, and release process updates belong under `docs/contributor/`.
- Release notes belong under `docs/releases/`.
- When adding a new release note, also update `docs/releases/latest.md` so the latest alias and `/releases/` entry stay current.

If a code change affects user-visible behavior, config, permissions, routing, cards, media, quoting, or troubleshooting, update the relevant `docs/` page in the same PR instead of adding ad-hoc detail to `README.md`.

## Architecture Boundaries

The canonical architecture guide lives in [`docs/contributor/architecture.en.md`](docs/contributor/architecture.en.md).
For Chinese readers, see [`docs/contributor/architecture.zh-CN.md`](docs/contributor/architecture.zh-CN.md).

Before adding a new module or widening an existing one, align with these rules:

- Keep `src/channel.ts` as an assembly layer
- Prefer logical domain boundaries before large physical file moves
- Put new code in a clear business domain instead of adding more flat root-level modules
- Separate behavior changes from broad structural moves when practical
- Treat the architecture document as the canonical placement and migration reference

Planned domain summary:

- `gateway/`: stream connection lifecycle, callback registration, inbound entry points
- `targeting/`: `conversationId`, peer identity, session aliasing, target resolution
- `messaging/`: inbound content extraction, reply strategies, outbound text/media delivery
- `card/`: AI card lifecycle, recovery, and cache behavior
- `command/`: slash commands, feedback learning, target-scoped command extensions
- `platform/`: config, auth, runtime, logger, and core types
- `shared/`: reusable persistence primitives, dedup, and cross-domain helpers

During the current transition, in-flight PRs are not expected to perform repo-wide moves. New code should still follow the documented boundaries.

## Quick Start

1. Fork and clone the repository.
2. Install dependencies.
3. Link the plugin into your local OpenClaw install.
4. Configure a test DingTalk app and workspace.
5. Run the validation commands before opening a PR.

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
openclaw plugins install -l .
```

If you need a clean local configuration flow, prefer:

```bash
openclaw onboard
```

or:

```bash
openclaw configure --section channels
```

## Local Development Setup

Recommended local setup:

- Keep a globally installed `openclaw` CLI/runtime for manual testing
- Keep this plugin as a standalone repository outside the OpenClaw parent repo
- Keep a local `~/Repo/openclaw` clone only for source navigation, `plugin-sdk` type resolution, and internal flow inspection

Recommended layout:

```text
~/Repo/openclaw
~/Repo/openclaw-channel-dingtalk
```

Then link the standalone plugin into the global OpenClaw environment:

```bash
cd ~/Repo/openclaw-channel-dingtalk
openclaw plugins install -l .
```

This repository's `tsconfig.json` is intentionally configured to resolve `openclaw/plugin-sdk` from either:

- `~/Repo/openclaw-channel-dingtalk -> ../openclaw/src/plugin-sdk`
- the older nested `~/Repo/openclaw/extensions/openclaw-channel-dingtalk -> ../../src/plugin-sdk`

That lets contributors move away from `submodule + worktree` development without breaking editor navigation or local type-checking.

Before testing changes locally:

- Make sure the plugin is allowed in `~/.openclaw/openclaw.json` via `plugins.allow: ["dingtalk"]`
- Create or reuse a DingTalk internal app with Robot capability enabled
- Set message receiving mode to Stream mode
- Publish the app version to the target tenant before testing callbacks
- Fill in the required DingTalk credentials in your OpenClaw config

See the structured docs for setup details:

- installation and local linking in `docs/user/getting-started/install.md`
- DingTalk app setup and permissions in `docs/user/getting-started/permissions.md`
- configuration in `docs/user/getting-started/configure.md`
- connection troubleshooting in `docs/user/troubleshooting/connection.en.md`
- Chinese troubleshooting guide in `docs/user/troubleshooting/connection.zh-CN.md`

## Validation Checklist

Run these commands before you open or update a PR:

```bash
npm run type-check
npm run lint
pnpm test
pnpm test:coverage
```

What each command covers:

- `npm run type-check` checks strict TypeScript correctness
- `npm run lint` checks style and type-aware lint rules
- `pnpm test` runs the Vitest unit and integration suites
- `pnpm test:coverage` helps confirm you did not leave the changed path untested

The test suite uses mocks for network calls. Do not depend on real DingTalk API access in automated tests.

## Test File Maintenance

When adding new tests or maintaining existing test files, follow these scale guidelines:

### Scale Thresholds

| Lines | Action |
|-------|--------|
| <500 | Acceptable, no action needed |
| 500-800 | Plan split for future work |
| >800 | Split required before merge |

### Split Strategy

1. **Identify feature domains** — Group tests by the feature they validate (e.g., quote handling, card lifecycle)
2. **Extract shared mocks** — Create fixture module in `tests/unit/fixtures/` for reusable mock setup
3. **Split by domain** — Create `source-module-{domain}.test.ts` files, each with 10-25 tests
4. **Retain core flows** — Keep end-to-end pipeline tests in the main file
5. **Clean redundancy** — Before splitting, merge tests that validate identical behavior ≥3 times

### Naming Convention

- Split files: `inbound-handler-quote.test.ts`, `send-service-media.test.ts`
- Fixture files: `tests/unit/fixtures/inbound-handler-fixture.ts`

## Manual Testing Expectations

If your change affects runtime behavior, include a short manual test note in the PR description.

Recommended manual checks:

- text messages in both direct chat and group chat
- media handling for image, voice, video, and file messages when relevant
- quoted message recovery if you touched inbound parsing or media/file handling
- AI card create, stream, finalize, and markdown fallback if you touched outbound or card flows
- retry and duplicate delivery behavior if you touched dedup, inflight protection, or callback ack timing

Useful repo entry points while testing:

- `tests/unit/`
- `tests/integration/`
- `scripts/dingtalk-stream-monitor.mjs`

## Special Validation By Issue Type

### Message loss or stream delivery changes (#104)

If your change touches inbound callback flow, connection lifecycle, deduplication, or ack behavior:

- collect arrival timestamps and message IDs
- note whether the message reached DingTalk, the stream client, and the plugin handler
- include any missing ID reconciliation you performed
- include monitor output when possible

You can use the stream monitor script for observation:

```bash
npm run monitor:stream -- --duration 300 --summary-every 30 --probe-every 20
```

Also reference the ongoing investigation in `README.md` and issue `#104` when your PR changes message arrival semantics.

### Module loading or SDK compatibility changes (#264)

If your change touches `dingtalk-stream` integration or startup behavior:

- include your Node.js version
- include the plugin install method (`npm`, local link, or manual copy)
- include the `dingtalk-stream` version from `package.json`
- describe exactly how you verified startup, connection open, and reconnect behavior

### Multi-image or message format parsing changes (#268)

If your change touches inbound message extraction or media parsing:

- include the exact reproduction steps
- include the raw or minimally redacted inbound payload shape when possible
- explain whether the case was single chat, group chat, quote reply, or mixed media
- confirm what automated tests were added or updated

## Filing Good Issues

Prefer using the GitHub issue templates under `.github/ISSUE_TEMPLATE/`.
For this repository, issue reports are encouraged to use Simplified Chinese so most contributors and users can discuss details efficiently.

Recommended issue guidance:

- use `问题反馈` for bugs, regressions, compatibility issues, or runtime failures
- use `功能建议` for feature requests, workflow improvements, or design ideas
- prefer a concise Chinese title that states the problem or expected outcome directly
- for bug reports, include `背景`, `复现步骤`, `期望行为`, `实际行为`, and `环境信息`
- for feature requests, include `背景`, `目标`, optional `建议的实现或思路`, and `验收标准或预期效果`
- include logs, screenshots, payload samples, or references when they materially help diagnosis
- redact secrets, tokens, tenant credentials, and private customer data before posting
- blank issues remain available, but following the template structure will usually get you faster help

When opening a bug report, include:

- plugin version
- OpenClaw version
- `dingtalk-stream` version
- Node.js version
- installation method (`openclaw plugins install`, `openclaw plugins install -l .`, or manual install)
- whether the problem happens in direct chat, group chat, or both
- relevant logs with timestamps
- exact reproduction steps

Please redact secrets, tokens, and private tenant information.

For high-signal bug reports, also include issue-specific evidence:

- for #104-style reports: missing message IDs, arrival windows, and any stream monitor output
- for #264-style reports: startup logs, module resolution errors, and environment details
- for #268-style reports: message payload samples and the exact multi-image formatting used

## Pull Request Guidance

Please keep PRs focused and easy to review:

- one problem or one tightly related improvement per PR
- use an English Conventional-style PR title, for example `fix(targeting): normalize learned display names`
- keep the title type, optional scope, and summary in English
- write the PR description in Simplified Chinese
- structure the PR description with clear sections for `背景`, `目标`, and `实现`
- include TODO checklists for both implementation and verification in the PR description
- link the related issue in the PR description
- describe both what changed and why it changed
- list automated validation you ran
- list manual validation you ran, if any

Recommended PR description outline:

- `背景`: why this change is needed and what problem or issue it addresses
- `目标`: what the PR is expected to achieve
- `实现`: the main implementation approach and important tradeoffs
- `实现 TODO`: a checkbox list of completed or remaining implementation items
- `验证 TODO`: a checkbox list of automated and manual verification items

For state-management changes, explicitly call out whether you changed behavior around:

- `dedup.processed-message`
- `session.lock`
- `channel.inflight`

These paths are intentionally process-local and memory-only. Do not introduce cross-process persistence or lock sharing without discussing the design first.

If your PR is AI-assisted, follow the parent OpenClaw convention and be transparent:

- mark the PR as AI-assisted in the title or description
- note the degree of testing you performed
- include prompts or session logs when they help reviewers understand the change
- confirm you understand the submitted code and validation results

## Testing Style Notes

- Prefer focused unit tests for parser, config, auth, dedup, and service logic
- Add integration tests when behavior crosses module boundaries such as gateway start, inbound dispatch, send lifecycle, or persistence migration
- Keep network access mocked in tests
- Match existing Vitest style in `tests/unit/` and `tests/integration/`

## Security and Sensitive Data

- Never commit tokens, app secrets, tenant credentials, or raw private customer payloads
- Redact IDs when sharing logs publicly unless the exact value is required for diagnosis
- Do not log raw access tokens in new code or test fixtures

For security issues, do not open a public bug report with exploit details. Follow the parent OpenClaw security reporting path described in the upstream contribution guide.

## Helpful References

- `README.md`
- `docs/user/troubleshooting/connection.en.md`
- `docs/user/troubleshooting/connection.zh-CN.md`
- `docs/assets/card-template.json`
- issue `#104`
- issue `#264`
- issue `#268`

Thanks for contributing.
