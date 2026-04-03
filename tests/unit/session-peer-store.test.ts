import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearSessionPeerOverride,
    getSessionPeerOverride,
    setSessionPeerOverride,
} from '../../src/session-peer-store';

let tempDir = '';
let storePath = '';
let stateDir = '';

describe('session-peer-store', () => {
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-session-peer-store-'));
        storePath = path.join(tempDir, 'session-peer-store.json');
        stateDir = path.join(path.dirname(storePath), 'dingtalk-state');
        fs.rmSync(stateDir, { recursive: true, force: true });
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = '';
        storePath = '';
        stateDir = '';
    });

    it('stores and reads per-group peerId override', () => {
        setSessionPeerOverride({
            storePath,
            accountId: 'main',
            sourceKind: 'group',
            sourceId: 'cid_group_1',
            peerId: 'shared-dev',
        });

        expect(
            getSessionPeerOverride({
                storePath,
                accountId: 'main',
                sourceKind: 'group',
                sourceId: 'cid_group_1',
            }),
        ).toBe('shared-dev');
    });

    it('stores and reads per-direct peerId override', () => {
        setSessionPeerOverride({
            storePath,
            accountId: 'main',
            sourceKind: 'direct',
            sourceId: 'user_123',
            peerId: 'shared-dev',
        });

        expect(
            getSessionPeerOverride({
                storePath,
                accountId: 'main',
                sourceKind: 'direct',
                sourceId: 'user_123',
            }),
        ).toBe('shared-dev');
    });

    it('clears override for a group', () => {
        setSessionPeerOverride({
            storePath,
            accountId: 'main',
            sourceKind: 'group',
            sourceId: 'cid_group_1',
            peerId: 'shared-dev',
        });

        expect(
            clearSessionPeerOverride({
                storePath,
                accountId: 'main',
                sourceKind: 'group',
                sourceId: 'cid_group_1',
            }),
        ).toBe(true);
        expect(
            getSessionPeerOverride({
                storePath,
                accountId: 'main',
                sourceKind: 'group',
                sourceId: 'cid_group_1',
            }),
        ).toBeUndefined();
    });

    it('retains override after module reload to simulate process restart', async () => {
        setSessionPeerOverride({
            storePath,
            accountId: 'main',
            sourceKind: 'group',
            sourceId: 'cid_group_1',
            peerId: 'shared-dev',
        });

        vi.resetModules();
        const reloaded = await import('../../src/session-peer-store');

        expect(
            reloaded.getSessionPeerOverride({
                storePath,
                accountId: 'main',
                sourceKind: 'group',
                sourceId: 'cid_group_1',
            }),
        ).toBe('shared-dev');
    });
});
