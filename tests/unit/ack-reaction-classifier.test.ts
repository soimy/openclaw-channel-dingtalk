import { describe, expect, it, vi } from 'vitest';
import { classifyAckReactionEmoji } from '../../src/ack-reaction-classifier';

describe('ack-reaction-classifier', () => {
    it('classifies praise content into praise emoji set', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(classifyAckReactionEmoji('你真棒，太厉害了')).toEqual({
                type: '夸奖',
                emoji: '叽 (๑•̀ㅂ•́)و✧',
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('classifies blame content into blame emoji set', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(classifyAckReactionEmoji('你怎么又搞砸了')).toEqual({
                type: '责怪',
                emoji: '叽 (╬ Ò﹏Ó)',
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('classifies command content into command emoji set', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(classifyAckReactionEmoji('马上去处理')).toEqual({
                type: '命令',
                emoji: '叽 (¬_¬)',
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('does not return the known unsupported kaomoji for command content', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.7);
        try {
            expect(classifyAckReactionEmoji('马上去处理').emoji).not.toBe('叽 ┌（┌ *｀д´）┐');
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('classifies request content into request emoji set', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(classifyAckReactionEmoji('请帮我看一下，可以吗？')).toEqual({
                type: '请求',
                emoji: '叽 (っ´∀｀)っ',
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('falls back to narrative emoji when no keyword matches', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(classifyAckReactionEmoji('今天天气不错')).toEqual({
                type: '叙事',
                emoji: '叽 (。・ω・。)',
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('returns unknown for invalid input', () => {
        expect(classifyAckReactionEmoji(undefined)).toEqual({
            type: '未知',
            emoji: '叽 (•̀_•́)',
        });
    });
});
