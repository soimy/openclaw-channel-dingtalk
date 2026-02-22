import { describe, expect, it } from 'vitest';
import { resolveGroupConfig, stripTargetPrefix } from '../../src/config';

describe('config helpers', () => {
    it('resolves group config with exact match then wildcard fallback', () => {
        const cfg = {
            groups: {
                cid_exact: { systemPrompt: 'exact prompt' },
                '*': { systemPrompt: 'fallback prompt' },
            },
        } as any;

        expect(resolveGroupConfig(cfg, 'cid_exact')).toEqual({ systemPrompt: 'exact prompt' });
        expect(resolveGroupConfig(cfg, 'cid_unknown')).toEqual({ systemPrompt: 'fallback prompt' });
    });

    it('strips explicit target prefixes correctly', () => {
        expect(stripTargetPrefix('group:cid123')).toEqual({ targetId: 'cid123', isExplicitUser: false });
        expect(stripTargetPrefix('user:user_1')).toEqual({ targetId: 'user_1', isExplicitUser: true });
        expect(stripTargetPrefix('raw_target')).toEqual({ targetId: 'raw_target', isExplicitUser: false });
    });
});
