# Gateway RPC compatibility

This plugin exposes DingTalk Gateway RPC methods in two namespaces:

- `dingtalk.*` is the canonical OpenClaw DingTalk plugin namespace.
- `dingtalk-connector.*` is a compatibility namespace for existing connector-style callers.

The compatibility namespace is a thin adapter over this repository's existing DingTalk implementation. It does not vendor, depend on, or promise feature parity with any separate DingTalk connector project. New callers should prefer the canonical `dingtalk.*` methods when they do not need compatibility with an existing `dingtalk-connector.*` integration.

## Compatibility boundary

The `dingtalk-connector.*` methods keep the smallest stable surface needed by Gateway callers:

- `dingtalk-connector.sendToUser` maps `userId` to `user:<userId>` and accepts `content` or `message`.
- `dingtalk-connector.sendToGroup` maps `openConversationId` to `group:<openConversationId>` and accepts `content` or `message`.
- `dingtalk-connector.send` accepts the canonical `target` string directly.
- `dingtalk-connector.status` reports configured DingTalk accounts.
- `dingtalk-connector.probe` validates account credentials by requesting an access token.
- `dingtalk-connector.docs.*` aliases share the same handlers as `dingtalk.docs.*`.

The compatibility methods intentionally reuse the canonical auth, send, docs, usage-tracking, and outbound-context persistence paths. If a future compatibility request requires behavior that differs from `dingtalk.*`, document that difference here before expanding the adapter.
