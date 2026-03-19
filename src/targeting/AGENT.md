# TARGETING KNOWLEDGE BASE

**Scope:** `src/targeting/`

## Overview

This directory owns DingTalk target parsing and the learned displayName directory used by outbound target resolution.

Current files:

- `target-input.ts`: normalize raw DingTalk targets and detect whether input already looks like a stable target ID
- `target-directory-store.ts`: persist learned group/user targets under namespace `targets.directory`, scoped by `accountId`
- `target-directory-adapter.ts`: bridge learned targets into `ChannelDirectoryEntry` lists and gate displayName lookup with `displayNameResolution`

## Responsibilities

- Keep DingTalk-specific target normalization and ID heuristics here
- Keep learned group/user displayName persistence here
- Keep learned directory lookup and adapter glue here

## Current Behavior

- Groups are persisted as `conversationId + currentTitle + historicalTitles + lastSeenAt`
- Users are persisted as `canonicalUserId/staffId/senderId + currentDisplayName + historicalDisplayNames + lastSeenInConversationIds`
- `displayNameResolution` supports:
  - `disabled`: default, no learned displayName lookup
  - `all`: enable learned group/user displayName lookup
- Owner-only displayName resolution is intentionally not implemented yet because upstream target resolution does not currently pass requester authz context into plugin resolver/directory entry points

## Important Notes

- Persistence is account-scoped and uses namespace `targets.directory`
- `target-directory-adapter.ts` contains a temporary resolver-only fallback that merges user entries into group lookup because the current upstream resolver classifies bare names as `group` before directory lookup
- Keep channel assembly concerns out of this directory; `src/channel.ts` remains the assembly layer

## When Extending

- Add new target parsing helpers here when they are DingTalk-specific
- Add new learned directory fields only when they directly improve target resolution or operator diagnostics
- Keep write amplification low; `target-directory-store.ts` already throttles `lastSeenAt` refreshes
