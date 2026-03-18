import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    formatGroupMembers,
    noteGroupMember,
} from '../../src/group-members-store';
import {
    clearCardContentCacheForTest,
} from '../../src/card-service';
import {
    clearMessageContextCacheForTest,
    resolveByAlias,
    resolveByMsgId,
} from '../../src/message-context-store';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('persistence migration sanity', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        clearMessageContextCacheForTest();
        clearCardContentCacheForTest();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function createStorePath(): string {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-persist-sanity-'));
        tempDirs.push(rootDir);
        return path.join(rootDir, 'session-store.json');
    }

    it('migrates legacy group roster and allows namespaced readback', () => {
        const storePath = createStorePath();
        const groupId = 'cid_group_legacy_sanity';
        const legacyFile = path.join(path.dirname(storePath), 'dingtalk-members', `${groupId}.json`);
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, JSON.stringify({ u1: 'Legacy Name' }, null, 2));

        const before = formatGroupMembers(storePath, groupId);
        expect(before).toContain('Legacy Name (u1)');

        noteGroupMember(storePath, groupId, 'u2', 'New Name');
        const after = formatGroupMembers(storePath, groupId);
        expect(after).toContain('Legacy Name (u1)');
        expect(after).toContain('New Name (u2)');

        const namespaced = resolveNamespacePath('members.group-roster', {
            storePath,
            scope: { groupId },
            format: 'json',
        });
        expect(fs.existsSync(namespaced)).toBe(true);
    });

    it('restores quoted message and card-content entries from unified persisted file after cache clear', () => {
        const storePath = createStorePath();
        const accountId = 'main';
        const conversationId = 'cid_restore';

        const unifiedPath = resolveNamespacePath('messages.context', {
            storePath,
            scope: { accountId, conversationId },
            format: 'json',
        });
        fs.mkdirSync(path.dirname(unifiedPath), { recursive: true });
        fs.writeFileSync(
            unifiedPath,
            JSON.stringify(
                {
                    version: 1,
                    updatedAt: Date.now(),
                    records: {
                        msg_restore: {
                            msgId: 'msg_restore',
                            direction: 'inbound',
                            topic: null,
                            accountId,
                            conversationId,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            expiresAt: Date.now() + 60_000,
                            messageType: 'file',
                            media: {
                                downloadCode: 'dl_restore',
                                spaceId: 'space_restore',
                                fileId: 'file_restore',
                            },
                        },
                        carrier_restore: {
                            msgId: 'carrier_restore',
                            direction: 'outbound',
                            topic: null,
                            accountId,
                            conversationId,
                            createdAt: 1_000_000,
                            updatedAt: Date.now(),
                            expiresAt: Date.now() + 60_000,
                            messageType: 'card',
                            text: 'restored card content',
                            delivery: {
                                processQueryKey: 'carrier_restore',
                                kind: 'proactive-card',
                            },
                        },
                    },
                },
                null,
                2,
            ),
        );

        clearMessageContextCacheForTest();
        clearCardContentCacheForTest();

        const quoted = resolveByMsgId({
            storePath,
            accountId,
            conversationId,
            msgId: 'msg_restore',
        });
        expect(quoted).not.toBeNull();
        expect(quoted!.media?.downloadCode).toBe('dl_restore');
        expect(quoted!.media?.spaceId).toBe('space_restore');

        const card = resolveByAlias({
            storePath,
            accountId,
            conversationId,
            kind: 'processQueryKey',
            value: 'carrier_restore',
        });
        expect(card?.text).toBe('restored card content');
    });
});
