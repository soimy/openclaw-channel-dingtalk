# DingTalk Native Approval

Native Approval allows OpenClaw approval requests to be handled directly from DingTalk.
It supports command execution approvals and plugin approvals.

## Enable

Configure approvers with DingTalk staff IDs. Prefixes such as `dingtalk:`, `dd:`, and `ding:` are optional.

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "execApprovals": {
        "enabled": "auto",
        "approvers": ["staff-id-1", "staff-id-2"]
      }
    }
  }
}
```

If `execApprovals.approvers` is empty, the plugin falls back to `commands.ownerAllowFrom`.

```json5
{
  "commands": {
    "ownerAllowFrom": ["staff-id-1"]
  },
  "channels": {
    "dingtalk": {
      "execApprovals": {
        "enabled": true
      }
    }
  }
}
```

Set `enabled` to `false` to disable DingTalk native delivery even when approvers are configured.

## Interaction

### AI Card Mode

When `messageType` is `card` and an active AI Card exists for the same DingTalk session, the plugin patches the existing card and shows three buttons:

- `允许一次`: approve once
- `总是允许`: approve always, when the request allows it
- `拒绝`: deny

While approval is pending, the normal stop button is hidden. After the approval is resolved or expired, approval buttons are removed. If the agent is still streaming, the stop button is restored.

### Markdown Mode

When there is no active AI Card, the plugin sends a Markdown approval message with copyable commands:

```text
/approve <approvalId> allow-once
/approve <approvalId> allow-always
/approve <approvalId> deny
```

Only decisions allowed by the OpenClaw request are shown.

### Command Fallback

Approvers can also send `/approve` manually in DingTalk:

```text
/approve abc123 allow-once
/approve allow-once abc123
```

The command path is intercepted before the normal agent session lock, so it can resolve a pending approval while the original agent turn is paused.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `execApprovals.enabled` | `boolean \| "auto"` | `"auto"` | `false` disables native delivery. `true` and `"auto"` enable it when approvers exist. |
| `execApprovals.approvers` | `string[]` | `[]` | DingTalk staff IDs allowed to approve. Falls back to `commands.ownerAllowFrom` when empty. |

## Limits

- v1 is origin-only: approvals are delivered back to the DingTalk chat that initiated the agent turn. Dedicated approver DM fan-out is not implemented yet.
- The card path removes buttons after resolution but does not write a final approval status line into the card.
- The card callback normally carries `cardPrivateData.params.approveId`. A process-local registry is kept only as a fallback for old cards or abnormal callback payloads.
- Real-device validation is still required after changing the DingTalk low-code card template or overriding `DINGTALK_CARD_TEMPLATE_ID`.

## Troubleshooting

- If no approval prompt appears, confirm `execApprovals.approvers` or `commands.ownerAllowFrom` contains the DingTalk staff ID of the approver.
- If the card buttons do not appear, confirm the runtime uses the v3 card template and `messageType` is `card`.
- If `/approve` says the decision is unsupported, choose one of the decisions shown in the Markdown or private hint.

## Related

- [AI Card](ai-card.md)
- [Configuration](../reference/configuration.md)
