import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig, isConfigured, mergeAccountWithDefaults, resolveRelativePath, resolveUserPath } from '../../src/config';

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

    it('named account inherits channel-level defaults', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'top_id',
                    clientSecret: 'top_sec',
                    dmPolicy: 'allowlist',
                    allowFrom: ['user1'],
                    showThinking: false,
                    messageType: 'card',
                    cardTemplateId: 'tpl.schema',
                    debug: true,
                    accounts: {
                        bot1: { clientId: 'bot1_id', clientSecret: 'bot1_sec' },
                    },
                },
            },
        } as any;

        const resolved = getConfig(cfg, 'bot1');
        expect(resolved.clientId).toBe('bot1_id');
        expect(resolved.clientSecret).toBe('bot1_sec');
        expect(resolved.dmPolicy).toBe('allowlist');
        expect(resolved.allowFrom).toEqual(['user1']);
        expect(resolved.showThinking).toBe(false);
        expect(resolved.messageType).toBe('card');
        expect(resolved.cardTemplateId).toBe('tpl.schema');
        expect(resolved.debug).toBe(true);
    });

    it('account-level overrides take precedence over channel-level', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'top_id',
                    clientSecret: 'top_sec',
                    dmPolicy: 'allowlist',
                    messageType: 'card',
                    accounts: {
                        bot2: {
                            clientId: 'bot2_id',
                            clientSecret: 'bot2_sec',
                            dmPolicy: 'open',
                            messageType: 'markdown',
                        },
                    },
                },
            },
        } as any;

        const resolved = getConfig(cfg, 'bot2');
        expect(resolved.dmPolicy).toBe('open');
        expect(resolved.messageType).toBe('markdown');
    });

    it('merged config does not leak accounts key', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'top_id',
                    clientSecret: 'top_sec',
                    accounts: {
                        bot1: { clientId: 'bot1_id', clientSecret: 'bot1_sec' },
                    },
                },
            },
        } as any;

        const resolved = getConfig(cfg, 'bot1');
        expect((resolved as any).accounts).toBeUndefined();
    });

    it('isConfigured validates by clientId/clientSecret', () => {
        expect(isConfigured({ channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } } as any)).toBe(true);
        expect(isConfigured({ channels: { dingtalk: { clientId: 'id' } } } as any)).toBe(false);
    });

    it('resolveRelativePath expands home and normalizes absolute/relative path', () => {
        const home = os.homedir();
        expect(resolveRelativePath('~')).toBe(path.resolve(home));
        expect(resolveRelativePath('~/a/b')).toBe(path.resolve(path.join(home, 'a/b')));
        expect(resolveRelativePath('~\\a\\b')).toBe(path.resolve(path.join(home, 'a', 'b')));
        expect(resolveRelativePath('/tmp/x')).toBe(path.resolve(path.sep, 'tmp', 'x'));
        expect(resolveRelativePath('./tmp/x')).toBe(path.resolve(process.cwd(), 'tmp', 'x'));
        expect(resolveRelativePath('../tmp/x')).toBe(path.resolve(process.cwd(), '..', 'tmp', 'x'));
        expect(resolveRelativePath('..\\tmp\\x')).toBe(path.resolve(process.cwd(), '..', 'tmp', 'x'));
    });

    it('resolveUserPath remains as backward-compatible alias', () => {
        expect(resolveUserPath('..\\tmp\\x')).toBe(resolveRelativePath('..\\tmp\\x'));
    });

});
