# Changelog

All notable changes to the DingTalk Channel plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-01-28

### Fixed

- **Cron Scheduled Tasks**: Fixed `"Outbound not configured for channel: dingtalk"` error preventing cron-scheduled messages from being delivered
- **Outbound Handler**: Added missing `resolveTarget` validation method to `outbound` block in plugin configuration
- **Target Resolution**: Proper validation of conversation IDs before message delivery

### Technical Details

- Added `resolveTarget` method that validates and normalizes target conversation IDs
- Method follows the same pattern as Discord, Telegram, and other production Clawdbot plugins
- Enables the lightweight outbound loader used by cron tasks to properly validate delivery targets
- No breaking changes; fully backward compatible with existing reactive message handling

### Testing

- ✅ Direct message send (baseline functionality)
- ✅ Cron scheduled tasks (core fix validation)
- ✅ Agent message delivery (integration testing)
- ✅ Gateway logs confirm error resolution

## [1.0.0] - 2026-01-27

### Added

- Initial release of DingTalk Channel plugin for Clawdbot
- Stream mode support (WebSocket long-connection, no public IP required)
- Private message support
- Group message support with @mention
- Multi-message type support (text, images, voice, video, files)
- Markdown reply support
- Complete AI conversation integration
- Comprehensive TypeScript type definitions (30+ interfaces)
- Unit tests with >80% coverage
- GitHub Actions CI/CD pipeline
- Complete developer documentation
- Enterprise-grade code quality standards

### Features

- ✅ **Stream Mode** — WebSocket long-connection, no public IP or Webhook
- ✅ **Private Chat** — Direct conversation with bot
- ✅ **Group Chat** — @mention bot in groups
- ✅ **Multi-Type Messages** — Text, images, voice (with OCR), video, files
- ✅ **Markdown Support** — Rich text formatting in replies
- ✅ **Full AI Integration** — Complete Clawdbot message pipeline
- ✅ **Type Safety** — 100% TypeScript coverage, 0 type errors
- ✅ **Testing** — 12 comprehensive unit tests
- ✅ **CI/CD** — Automated GitHub Actions pipeline

### Documentation

- User guide with installation and configuration
- Developer guide with setup and development workflow
- Architecture documentation
- Type system reference
- Troubleshooting guide
- Contributing guidelines
