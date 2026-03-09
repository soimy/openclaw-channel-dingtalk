# Contributing to OpenClaw DingTalk Channel

中文版请见：[`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)

Thanks for helping improve the DingTalk channel plugin for OpenClaw.

This repository has a few areas that need extra care when you change them:

- Stream-mode connection lifecycle and inbound callback handling
- Memory-only runtime state such as `dedup.processed-message`, `session.lock`, and `channel.inflight`
- Quoted message recovery across text, media, file, and AI card flows
- DingTalk platform behavior that can vary by tenant, app permissions, and `dingtalk-stream` version

Use this guide as the contributor entry point, then follow the deeper links in `README.md` and `docs/` for platform-specific details.

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

Before testing changes locally:

- Make sure the plugin is allowed in `~/.openclaw/openclaw.json` via `plugins.allow: ["dingtalk"]`
- Create or reuse a DingTalk internal app with Robot capability enabled
- Set message receiving mode to Stream mode
- Publish the app version to the target tenant before testing callbacks
- Fill in the required DingTalk credentials in your OpenClaw config

See `README.md` for the full setup details:

- installation and local linking in `README.md`
- DingTalk app setup and permissions in `README.md`
- connection troubleshooting in `docs/connection-troubleshooting.md`
- Chinese troubleshooting guide in `docs/connection-troubleshooting.zh-CN.md`

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
- link the related issue in the PR description
- describe both what changed and why it changed
- list automated validation you ran
- list manual validation you ran, if any

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
- `docs/connection-troubleshooting.md`
- `docs/connection-troubleshooting.zh-CN.md`
- `docs/cardTemplate.json`
- issue `#104`
- issue `#264`
- issue `#268`

Thanks for contributing.
