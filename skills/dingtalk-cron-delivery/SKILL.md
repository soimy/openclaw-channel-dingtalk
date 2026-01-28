---
name: dingtalk-cron-delivery
description: Guide for scheduling DingTalk messages via Clawdbot cron with correct isolated session configuration for delivery support
metadata: { 'clawdbot': { 'requires': { 'config': ['channels.dingtalk.enabled'] } } }
---

# DingTalk Cron Delivery Guide

**Purpose**: Ensure cron-scheduled DingTalk messages are created with the correct payload type (`agentTurn` instead of `systemEvent`)

**When to Use**: Whenever scheduling messages to be delivered to DingTalk via cron jobs or delayed tasks

---

## Problem & Solution

### The Problem

DingTalk can receive messages in two ways:

1. **Reactive messages** (in response to user input) — Always work ✅
2. **Proactive messages** (cron jobs, scheduled tasks) — Only work with the correct configuration ⚠️

Users often instinctively try to create scheduled messages like this:

```bash
# ❌ WRONG: This creates a "systemEvent" in the main session
clawdbot cron add \
  --session main \
  --at "10s" \
  --text "Hello DingTalk"
```

This fails silently because `systemEvent` payloads don't trigger the delivery system.

### The Solution

**Always use `--session isolated` for scheduled DingTalk messages:**

```bash
# ✅ CORRECT: Creates an "agentTurn" in isolated session, supports delivery
clawdbot cron add \
  --session isolated \
  --at "10s" \
  --message "Hello DingTalk" \
  --deliver \
  --channel dingtalk \
  --to "ding2e110e56701b50e4"
```

---

## Architecture Concepts

### Two Cron Execution Paths

Clawdbot cron has **two distinct execution models** based on `sessionTarget`:

#### Path 1: Main Session (`systemEvent`)

```
cron.add(--session main)
  ↓
enqueueSystemEvent() — adds text to agent's message queue
  ↓
Next heartbeat processes it
  ↓
❌ NO DELIVERY (internal-only)
```

**Use for**: Reminders, internal state updates, waking up the agent

**Key trait**: No outbound delivery support

#### Path 2: Isolated Session (`agentTurn`)

```
cron.add(--session isolated)
  ↓
runCronIsolatedAgentTurn() — dedicated AI agent execution
  ↓
Agent generates payloads
  ↓
deliverOutboundPayloads() — delivery infrastructure engaged
  ↓
plugin.outbound.resolveTarget() — target validation
  ↓
plugin.outbound.sendText() — sends to DingTalk API
  ↓
✅ MESSAGE DELIVERED
```

**Use for**: Scheduled messages, delayed notifications, proactive outreach

**Key trait**: Full delivery support to all channels (DingTalk, Telegram, Discord, WhatsApp, etc.)

---

## How to Create Scheduled DingTalk Messages

### Via CLI

**Basic syntax:**

```bash
clawdbot cron add \
  --name "Task Name" \
  --session isolated \
  --at "SCHEDULE" \
  --message "MESSAGE_TEXT" \
  --deliver \
  --channel dingtalk \
  --to "TARGET_ID"
```

**Schedule format** (`--at`):

- `"10s"` — 10 seconds from now
- `"5m"` — 5 minutes from now
- `"2h"` — 2 hours from now
- `"14:30"` — 2:30 PM today (HH:MM format, 24-hour)
- `"2024-01-28T14:30:00Z"` — ISO 8601 format

**Target ID** (`--to`):

- Group ID: `cid...` (starts with `cid`)
- Personal ID: StaffID (numeric or alphanumeric)
- Get from DingTalk: Right-click group/person → Copy ID

### Examples

**Send a reminder in 10 seconds:**

```bash
clawdbot cron add \
  --name "DingTalk Scheduled Test" \
  --session isolated \
  --at "10s" \
  --message "🔔 This is a scheduled message from Clawdbot!" \
  --deliver \
  --channel dingtalk \
  --to "ding2e110e56701b50e4"
```

**Send at specific time:**

```bash
clawdbot cron add \
  --name "Daily Standup Reminder" \
  --session isolated \
  --at "09:30" \
  --message "⏰ Daily standup in 30 minutes" \
  --deliver \
  --channel dingtalk \
  --to "cidxxxxx"  # group ID
```

**Send after AI reasoning (advanced):**

```bash
clawdbot cron add \
  --name "AI Analysis Task" \
  --session isolated \
  --at "2h" \
  --message "Summarize the latest project updates and send to DingTalk. Be concise." \
  --deliver \
  --channel dingtalk \
  --to "cidxxxxx"
```

In this case:

- The AI reads the message as a task description
- The AI performs the analysis
- The AI's response is automatically delivered to DingTalk

### Via Agent Request

You can ask the AI to create scheduled tasks:

**User:** "Schedule a reminder to the DingTalk group about the meeting in 30 minutes"

**AI understands:**

- Creates a cron task with `--session isolated` (not main)
- Uses `--deliver` flag
- Targets `--channel dingtalk`
- Includes the group conversation ID in `--to`

This skill ensures the AI always chooses the right configuration.

---

## Key Parameters Explained

| Parameter            | Usage                       | DingTalk-specific                             |
| -------------------- | --------------------------- | --------------------------------------------- |
| `--session isolated` | **REQUIRED** for delivery   | ✅ Always use for DingTalk scheduled messages |
| `--message`          | Task prompt or message text | Can be a direct message or a task for AI      |
| `--deliver`          | Enable outbound delivery    | ✅ MUST set for DingTalk messages             |
| `--channel dingtalk` | Target channel              | ✅ Specifies DingTalk as the delivery channel |
| `--to`               | Recipient ID                | ✅ Copy from DingTalk (group/person ID)       |
| `--at`               | Schedule timing             | Any valid cron schedule format                |

---

## Common Mistakes & How to Avoid Them

### ❌ Mistake 1: Using `--session main`

```bash
clawdbot cron add \
  --session main \              # ❌ WRONG
  --text "Hello"
```

**Problem**: Enqueues as `systemEvent`, bypasses delivery system

**Fix**: Use `--session isolated` instead

```bash
clawdbot cron add \
  --session isolated \          # ✅ CORRECT
  --message "Hello" \
  --deliver \
  --channel dingtalk \
  --to "..."
```

### ❌ Mistake 2: Forgetting `--deliver` flag

```bash
clawdbot cron add \
  --session isolated \
  --message "Hello" \
  --channel dingtalk \
  --to "ding..."               # ❌ Missing --deliver
```

**Problem**: Task runs but delivery is not requested

**Fix**: Add `--deliver` flag

```bash
clawdbot cron add \
  --session isolated \
  --message "Hello" \
  --deliver \                   # ✅ CORRECT
  --channel dingtalk \
  --to "ding..."
```

### ❌ Mistake 3: Wrong conversation ID format

```bash
clawdbot cron add \
  --to "john.doe"              # ❌ Username, not ID
```

**Problem**: DingTalk API doesn't recognize the format

**Fix**: Use the actual conversation ID

```bash
clawdbot cron add \
  --to "ding2e110e56701b50e4"  # ✅ CORRECT (starts with 'ding' or numeric)
```

### ❌ Mistake 4: Omitting `--channel dingtalk`

```bash
clawdbot cron add \
  --session isolated \
  --message "Hello" \
  --deliver \
  --to "ding..."               # ❌ Delivery target unclear
```

**Problem**: System doesn't know which channel to use

**Fix**: Explicitly specify the channel

```bash
clawdbot cron add \
  --session isolated \
  --message "Hello" \
  --deliver \
  --channel dingtalk \         # ✅ CORRECT
  --to "ding..."
```

---

## Verification Checklist

Before creating a scheduled DingTalk message, verify:

- [ ] **`--session isolated`** — Not `main`
- [ ] **`--deliver`** flag is present
- [ ] **`--channel dingtalk`** explicitly specified
- [ ] **`--to` parameter** is a valid DingTalk ID:
  - Group: starts with `cid` (e.g., `cidxxxxx`)
  - Person: StaffID (numeric or alphanumeric, e.g., `123456`)
- [ ] **`--message` or `--text`** is provided:
  - `--message`: for AI reasoning (preferred)
  - `--text`: for static text (rare)

---

## Monitoring & Debugging

### Check if a cron task was created

```bash
clawdbot cron list
```

Look for your task in the output. If it's there, creation succeeded.

### Check if a task is running

```bash
clawdbot logs | grep dingtalk
```

Wait for the scheduled time and watch the logs. You should see:

1. Task execution start
2. AI agent reasoning (if `--message` was used)
3. Delivery attempt to DingTalk
4. Success or error response

### If message didn't arrive

**Check in this order:**

1. **Did the task run?**
   - Check logs for the task ID execution
   - Verify the scheduled time passed

2. **Did delivery succeed?**
   - Look for `"Outbound not configured"` errors
   - Verify `resolveTarget` was called (should see success log)

3. **Is the DingTalk account configured?**
   - Verify `channels.dingtalk` config in `~/.clawdbot/clawdbot.json`
   - Check `clientId`, `clientSecret`, `agentId` are set
   - Restart gateway if config changed

4. **Is the target ID valid?**
   - Verify the ID matches the format (starts with `cid` or numeric)
   - Test with a known working ID first

---

## Why This Matters

### The Underlying Problem

Clawdbot's cron system has **two modes**:

- **Main session**: For internal state updates, not delivery
- **Isolated session**: For external messaging, full delivery support

The AI doesn't inherently know which mode to use for DingTalk. Without guidance, it defaults to `main` (simpler, faster) but that mode doesn't support delivery.

### How This Skill Helps

This skill teaches the AI:

1. **When** to use isolated sessions (DingTalk scheduled messages)
2. **What** parameters are required (`--deliver`, `--channel`, `--to`)
3. **How** to get target IDs from DingTalk
4. **Why** both parameters matter for the delivery chain

### The Delivery Chain

Once the AI creates a task with the correct parameters:

```
cron service validates → isolated agent executes → delivery system engages
→ plugin.outbound.resolveTarget() validates target → DingTalk API sends message
```

If any step uses wrong parameters, the message silently fails. This skill prevents that.

---

## Related Documentation

- **Cron Jobs**: `/node_modules/clawdbot/docs/automation/cron-jobs.md`
- **DingTalk Channel**: `/extensions/dingtalk-channel/README.md`
- **Plugin System**: `/node_modules/clawdbot/docs/plugin.md`

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────┐
│ DingTalk Scheduled Messages Quick Reference     │
├─────────────────────────────────────────────────┤
│                                                 │
│ ✅ REQUIRED:                                    │
│   --session isolated                            │
│   --deliver                                     │
│   --channel dingtalk                            │
│   --to <conversation-id>                        │
│   --message "text" OR --text "text"             │
│   --at "schedule"                               │
│                                                 │
│ ❌ DON'T USE:                                   │
│   --session main                                │
│   No --deliver flag                             │
│   Missing --channel                             │
│                                                 │
│ 📍 Target ID Examples:                          │
│   Group: ding2e110e56701b50e4 (starts w/ ding) │
│   Person: 123456 (StaffID)                      │
│                                                 │
│ ⏰ Schedule Examples:                            │
│   "10s" (10 seconds)                            │
│   "5m" (5 minutes)                              │
│   "14:30" (2:30 PM today)                       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

**Last Updated**: 2026-01-28  
**For DingTalk Channel**: v1.0.1+  
**Compatible with**: Clawdbot 2026+
