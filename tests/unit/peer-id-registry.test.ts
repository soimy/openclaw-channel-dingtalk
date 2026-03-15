import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    homeDir: '',
}));

vi.mock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
        ...actual,
        homedir: () => mocked.homeDir,
    };
});

function writeSessions(homeDir: string, sessions: Record<string, unknown>): void {
    const sessionsDir = join(homeDir, '.openclaw', 'agents', 'agent-a', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify(sessions), 'utf-8');
}

function writeMalformedSessions(homeDir: string): void {
    const sessionsDir = join(homeDir, '.openclaw', 'agents', 'agent-b', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), '{ bad json', 'utf-8');
}

describe('peer id registry preload', () => {
    let tempHomeDir = '';

    beforeEach(() => {
        vi.resetModules();
        tempHomeDir = mkdtempSync(join(tmpdir(), 'dingtalk-peer-registry-'));
        mocked.homeDir = tempHomeDir;
    });

    afterEach(() => {
        if (tempHomeDir && existsSync(tempHomeDir)) {
            rmSync(tempHomeDir, { recursive: true, force: true });
        }
    });

    it('lazy preload runs once and clear resets lazy preload state', async () => {
        writeSessions(tempHomeDir, {
            s1: {
                lastTo: 'cidAbC123==',
                origin: {
                    from: 'cidFrOm111==',
                    to: 'cidTo222==',
                },
            },
        });

        const peer = await import('../../src/peer-id-registry');

        expect(peer.resolveOriginalPeerId('cidabc123==')).toBe('cidAbC123==');
        expect(peer.resolveOriginalPeerId('cidfrom111==')).toBe('cidFrOm111==');
        expect(peer.resolveOriginalPeerId('cidto222==')).toBe('cidTo222==');

        writeSessions(tempHomeDir, {
            s2: {
                lastTo: 'cidNeW456==',
            },
        });
        expect(peer.resolveOriginalPeerId('cidnew456==')).toBe('cidnew456==');

        peer.clearPeerIdRegistry();
        expect(peer.resolveOriginalPeerId('cidnew456==')).toBe('cidNeW456==');
    });

    it('preload without explicit homeDir is idempotent', async () => {
        writeSessions(tempHomeDir, {
            s1: {
                lastTo: 'cidFiRsT111==',
            },
        });

        const peer = await import('../../src/peer-id-registry');

        peer.preloadPeerIdsFromSessions();
        expect(peer.resolveOriginalPeerId('cidfirst111==')).toBe('cidFiRsT111==');

        writeSessions(tempHomeDir, {
            s2: {
                lastTo: 'cidSecond222==',
            },
        });
        peer.preloadPeerIdsFromSessions();
        expect(peer.resolveOriginalPeerId('cidsecond222==')).toBe('cidsecond222==');

        peer.preloadPeerIdsFromSessions(tempHomeDir);
        expect(peer.resolveOriginalPeerId('cidsecond222==')).toBe('cidSecond222==');
    });

    it('ignores missing or malformed sessions.json files', async () => {
        writeMalformedSessions(tempHomeDir);
        mkdirSync(join(tempHomeDir, '.openclaw', 'agents', 'agent-c'), { recursive: true });

        const peer = await import('../../src/peer-id-registry');

        expect(() => peer.preloadPeerIdsFromSessions()).not.toThrow();
        expect(peer.resolveOriginalPeerId('cidunknown==')).toBe('cidunknown==');
    });

    it('retries lazy preload after top-level scan failure', async () => {
        const brokenHomePath = join(tempHomeDir, 'broken-home');
        writeFileSync(brokenHomePath, 'not-a-directory', 'utf-8');
        mocked.homeDir = brokenHomePath;

        const peer = await import('../../src/peer-id-registry');

        expect(peer.resolveOriginalPeerId('cidretry111==')).toBe('cidretry111==');

        const validHomePath = join(tempHomeDir, 'valid-home');
        writeSessions(validHomePath, {
            s1: {
                lastTo: 'cidReTrY111==',
            },
        });
        mocked.homeDir = validHomePath;

        expect(peer.resolveOriginalPeerId('cidretry111==')).toBe('cidReTrY111==');
    });
});
