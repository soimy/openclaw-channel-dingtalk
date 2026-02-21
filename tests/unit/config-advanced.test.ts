import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig, isConfigured, resolveAgentWorkspaceDir, resolveUserPath } from '../../src/config';

describe('config advanced', () => {
    it('getConfig resolves account override and top-level fallback', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'top_id',
                    clientSecret: 'top_sec',
                    accounts: {
                        main: { clientId: 'main_id', clientSecret: 'main_sec' },
                    },
                },
            },
        } as any;

        expect(getConfig(cfg, 'main').clientId).toBe('main_id');
        expect(getConfig(cfg, 'unknown').clientId).toBe('top_id');
    });

    it('isConfigured validates by clientId/clientSecret', () => {
        expect(isConfigured({ channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } } as any)).toBe(true);
        expect(isConfigured({ channels: { dingtalk: { clientId: 'id' } } } as any)).toBe(false);
    });

    it('resolveUserPath expands home and normalizes absolute path', () => {
        const home = os.homedir();
        expect(resolveUserPath('~/a/b')).toBe(path.resolve(path.join(home, 'a/b')));
        expect(resolveUserPath('/tmp/x')).toBe(path.resolve('/tmp/x'));
    });

    it('resolveAgentWorkspaceDir honors agent workspace and defaults', () => {
        const cfg = {
            agents: {
                list: [
                    { id: 'main', default: true, workspace: '~/custom-main' },
                    { id: 'other' },
                ],
            },
        } as any;

        expect(resolveAgentWorkspaceDir(cfg, 'main')).toContain('custom-main');
        expect(resolveAgentWorkspaceDir(cfg, 'other')).toContain('workspace-other');
    });
});
