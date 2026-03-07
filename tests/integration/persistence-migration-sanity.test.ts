import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    formatGroupMembers,
    noteGroupMember,
} from '../../src/group-members-store';
import {
    clearQuotedMsgCacheForTest,
    getCachedDownloadCode,
} from '../../src/quoted-msg-cache';
import {
    clearCardContentCacheForTest,
    findCardContent,
} from '../../src/card-service';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('persistence migration sanity', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        clearQuotedMsgCacheForTest();
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

    it('restores quoted message and card-content entries from persisted files after cache clear', () => {
        const storePath = createStorePath();
        const accountId = 'main';
        const conversationId = 'cid_restore';

        const quotedPath = resolveNamespacePath('quoted.msg-download-code', {
            storePath,
            scope: { accountId, conversationId },
            format: 'json',
        });
        fs.mkdirSync(path.dirname(quotedPath), { recursive: true });
        fs.writeFileSync(
            quotedPath,
            JSON.stringify(
                {
                    updatedAt: Date.now(),
                    entries: {
                        msg_restore: {
                            downloadCode: 'dl_restore',
                            msgType: 'file',
                            createdAt: Date.now(),
                            expiresAt: Date.now() + 60_000,
                            spaceId: 'space_restore',
                            fileId: 'file_restore',
                        },
                    },
                },
                null,
                2,
            ),
        );

        const cardPath = resolveNamespacePath('cards.content.quote-lookup', {
            storePath,
            scope: { accountId, conversationId },
            format: 'json',
        });
        fs.mkdirSync(path.dirname(cardPath), { recursive: true });
        fs.writeFileSync(
            cardPath,
            JSON.stringify(
                {
                    updatedAt: Date.now(),
                    entries: [
                        {
                            content: 'restored card content',
                            createdAt: 1_000_000,
                            expiresAt: Date.now() + 60_000,
                        },
                    ],
                },
                null,
                2,
            ),
        );

        clearQuotedMsgCacheForTest();
        clearCardContentCacheForTest();

        const quoted = getCachedDownloadCode(accountId, conversationId, 'msg_restore', storePath);
        expect(quoted).not.toBeNull();
        expect(quoted!.downloadCode).toBe('dl_restore');
        expect(quoted!.spaceId).toBe('space_restore');

        const card = findCardContent(accountId, conversationId, 1_000_500, storePath);
        expect(card).toBe('restored card content');
    });
});
