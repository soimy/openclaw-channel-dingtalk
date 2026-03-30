import { beforeEach, describe, expect, it } from 'vitest';

import {
    clearQuotedFileServiceCachesForTest,
    parseDingTalkFileTime,
} from '../../src/messaging/quoted-file-service';

describe('quoted-file-service', () => {
    beforeEach(() => {
        clearQuotedFileServiceCachesForTest();
    });

    it('parseDingTalkFileTime 正确解析 CST 时间字符串', () => {
        const input = 'Fri Mar 06 16:33:28 CST 2026';
        const actual = parseDingTalkFileTime(input);
        const expected = new Date('2026-03-06T08:33:28.000Z').getTime();
        expect(actual).toBe(expected);
    });

    it('parseDingTalkFileTime 无效字符串抛错', () => {
        expect(() => parseDingTalkFileTime('invalid time string')).toThrow(Error);
        expect(() => parseDingTalkFileTime('invalid time string')).toThrow('Cannot parse');
    });
});
