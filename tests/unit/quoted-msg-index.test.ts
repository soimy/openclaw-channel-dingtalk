import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    cacheQuotedCardContent,
    cacheQuotedFileMetadata,
    getQuotedCardContent,
    getQuotedFileMetadata,
} from '../../src/quoted-msg-index';

describe('quoted-msg-index', () => {
    let tempDir = '';
    let storePath = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-dingtalk-quoted-index-'));
        storePath = path.join(tempDir, 'session-store.json');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it('persists card content by processQueryKey', () => {
        cacheQuotedCardContent({
            storePath,
            accountId: 'main',
            conversationId: 'cid1',
            processQueryKey: 'carrier_1',
            content: 'card content',
        });

        expect(
            getQuotedCardContent({
                storePath,
                accountId: 'main',
                conversationId: 'cid1',
                processQueryKey: 'carrier_1',
            })
        ).toBe('card content');
    });

    it('persists file metadata by msgId', () => {
        cacheQuotedFileMetadata({
            storePath,
            accountId: 'main',
            conversationId: 'cid1',
            msgId: 'msg_file_1',
            downloadCode: 'download_1',
            msgType: 'file',
            createdAt: 123456,
            spaceId: 'space_1',
            fileId: 'file_1',
        });

        expect(
            getQuotedFileMetadata({
                storePath,
                accountId: 'main',
                conversationId: 'cid1',
                msgId: 'msg_file_1',
            })
        ).toEqual({
            downloadCode: 'download_1',
            msgType: 'file',
            createdAt: 123456,
            expiresAt: expect.any(Number),
            spaceId: 'space_1',
            fileId: 'file_1',
        });
    });

    it('persists file metadata without downloadCode when spaceId/fileId are available', () => {
        cacheQuotedFileMetadata({
            storePath,
            accountId: 'main',
            conversationId: 'cid1',
            msgId: 'msg_file_2',
            msgType: 'file',
            createdAt: 222222,
            spaceId: 'space_2',
            fileId: 'file_2',
        });

        expect(
            getQuotedFileMetadata({
                storePath,
                accountId: 'main',
                conversationId: 'cid1',
                msgId: 'msg_file_2',
            })
        ).toEqual({
            downloadCode: undefined,
            msgType: 'file',
            createdAt: 222222,
            expiresAt: expect.any(Number),
            spaceId: 'space_2',
            fileId: 'file_2',
        });
    });
});
