import { describe, expect, it } from 'vitest';
import { generateDingTalkSignature } from '../../src/signature';

describe('generateDingTalkSignature', () => {
    it('should generate stable HmacSHA256 + Base64 signature for fixed timestamp/secret', () => {
        const timestamp = '1700000000000';
        const secret = 'SECabc123';

        const result = generateDingTalkSignature(timestamp, secret);

        expect(result).toBe('N5P09a4+p1AMJIJWnIvQd2Yxw9+fu/oEBnPrjCcsLXk=');
    });

    it('should throw when secret is empty', () => {
        expect(() => generateDingTalkSignature(1700000000000, '')).toThrow(
            'secret is required for DingTalk signature generation'
        );
    });
});
