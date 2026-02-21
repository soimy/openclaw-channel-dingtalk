import { describe, expect, it } from 'vitest';
import { isSenderAllowed, isSenderGroupAllowed, normalizeAllowFrom } from '../../src/access-control';

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
