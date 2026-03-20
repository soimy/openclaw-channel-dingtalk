import { describe, expect, it } from 'vitest';
import { isSenderAllowed, isSenderGroupAllowed, normalizeAllowFrom, resolveGroupAccess } from '../../src/access-control';

describe('access-control', () => {
    it('normalizes allowFrom entries and strips dingtalk prefixes', () => {
        const allow = normalizeAllowFrom([' dingtalk:USER_1 ', 'dd:Group_1', '*']);

        expect(allow.entries).toEqual(['USER_1', 'Group_1']);
        expect(allow.entriesLower).toEqual(['user_1', 'group_1']);
        expect(allow.hasWildcard).toBe(true);
        expect(allow.hasEntries).toBe(true);
    });

    it('allows sender by case-insensitive match and wildcard', () => {
        const strictAllow = normalizeAllowFrom(['ding:User_A']);
        const wildcardAllow = normalizeAllowFrom(['*']);

        expect(isSenderAllowed({ allow: strictAllow, senderId: 'user_a' })).toBe(true);
        expect(isSenderAllowed({ allow: strictAllow, senderId: 'other' })).toBe(false);
        expect(isSenderAllowed({ allow: wildcardAllow, senderId: 'whatever' })).toBe(true);
    });

    it('checks group allow list with case-insensitive comparison', () => {
        const allow = normalizeAllowFrom(['cidABC123']);

        expect(isSenderGroupAllowed({ allow, groupId: 'cidabc123' })).toBe(true);
        expect(isSenderGroupAllowed({ allow, groupId: 'cidzzz' })).toBe(false);
    });
});

describe('resolveGroupAccess', () => {
    it('returns allowed when groupPolicy is open and no sender restriction', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'open',
            groupId: 'any_group',
            senderId: 'any_sender',
        });
        expect(result.allowed).toBe(true);
    });

    it('returns blocked when groupPolicy is disabled', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'disabled',
            groupId: 'any_group',
            senderId: 'any_sender',
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('disabled');
    });

    it('allows group listed in groups config (allowlist)', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidXXX',
            senderId: 'user_1',
            groups: { 'cidXXX': {} },
        });
        expect(result.allowed).toBe(true);
    });

    it('allows group via wildcard "*" in groups (allowlist)', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidANY',
            senderId: 'user_1',
            groups: { '*': {} },
        });
        expect(result.allowed).toBe(true);
    });

    it('falls back to legacy allowFrom for group ID match (allowlist)', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidXXX',
            senderId: 'user_1',
            allowFrom: ['cidXXX'],
        });
        expect(result.allowed).toBe(true);
        expect(result.legacyFallback).toBe(true);
    });

    it('blocks group not in any allowlist', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidBLOCKED',
            senderId: 'user_1',
            groups: { 'cidOTHER': {} },
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('group_not_allowed');
    });

    it('blocks sender not in per-group groupAllowFrom', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidXXX',
            senderId: 'user_blocked',
            groups: { 'cidXXX': { groupAllowFrom: ['user_ok'] } },
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('sender_not_allowed');
    });

    it('checks wildcard groupAllowFrom when per-group not set', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidXXX',
            senderId: 'user_ok',
            groups: { 'cidXXX': {}, '*': { groupAllowFrom: ['user_ok'] } },
        });
        expect(result.allowed).toBe(true);
    });

    it('checks top-level groupAllowFrom as final fallback', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'open',
            groupId: 'cidXXX',
            senderId: 'user_blocked',
            groupAllowFrom: ['user_ok'],
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('sender_not_allowed');
    });

    it('passes when no groupAllowFrom configured anywhere', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'allowlist',
            groupId: 'cidXXX',
            senderId: 'any_user',
            groups: { 'cidXXX': {} },
        });
        expect(result.allowed).toBe(true);
    });

    it('supports dingtalk: prefix in groupAllowFrom', () => {
        const result = resolveGroupAccess({
            groupPolicy: 'open',
            groupId: 'cidXXX',
            senderId: 'user_ok',
            groupAllowFrom: ['dingtalk:user_ok'],
        });
        expect(result.allowed).toBe(true);
    });
});
