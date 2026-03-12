import { describe, expect, it } from 'vitest';
import { resolveDingTalkSessionPeer } from '../../src/session-routing';

describe('resolveDingTalkSessionPeer', () => {
    it('uses senderId for direct messages', () => {
        expect(
            resolveDingTalkSessionPeer({
                isDirect: true,
                senderId: 'user_123',
                conversationId: 'cid_group_1',
                config: {},
            }),
        ).toEqual({
            kind: 'direct',
            peerId: 'user_123',
        });
    });

    it('uses conversationId for group messages by default', () => {
        expect(
            resolveDingTalkSessionPeer({
                isDirect: false,
                senderId: 'user_123',
                conversationId: 'cid_group_1',
                config: {},
            }),
        ).toEqual({
            kind: 'group',
            peerId: 'cid_group_1',
        });
    });

    it('prefers peerId override for group sharing', () => {
        expect(
            resolveDingTalkSessionPeer({
                isDirect: false,
                senderId: 'user_123',
                conversationId: 'cid_group_1',
                peerIdOverride: 'shared-dev',
                config: {},
            }),
        ).toEqual({
            kind: 'group',
            peerId: 'shared-dev',
        });
    });

    it('prefers peerId override for direct sharing', () => {
        expect(
            resolveDingTalkSessionPeer({
                isDirect: true,
                senderId: 'user_123',
                conversationId: 'cid_dm_1',
                peerIdOverride: 'shared-dev',
                config: {},
            }),
        ).toEqual({
            kind: 'direct',
            peerId: 'shared-dev',
        });
    });
});
