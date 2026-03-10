import { describe, it, expect } from 'vitest';
import classifySentenceWithEmoji from '../../src/classifyWithEmoji.js';

describe('classifySentenceWithEmoji', () => {
  // 验证返回结构
  it('should return ClassifyResult with type and emoji', () => {
    const result = classifySentenceWithEmoji('你好');
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('emoji');
    expect(typeof result.type).toBe('string');
    expect(typeof result.emoji).toBe('string');
  });

  // 空值/无效输入处理
  describe('invalid inputs', () => {
    it.each([null, undefined, '', 123, {}])('should return 未知 for invalid input: %s', (input) => {
      const result = classifySentenceWithEmoji(input);
      expect(result.type).toBe('未知');
    });
  });

  // 夸奖类型
  describe('praise classification', () => {
    const praiseCases: string[] = ['你真棒！', '干得漂亮！', '太好了', '你好厉害'];

    it.each(praiseCases)('should classify "%s" as 夸奖', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).toBe('夸奖');
    });
  });

  // 责怪类型
  describe('blame classification', () => {
    const blameCases: string[] = ['作业又没写完，太差了！', '怎么又搞砸了', '这也太糟糕了吧'];

    it.each(blameCases)('should classify "%s" as 责怪', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).toBe('责怪');
    });
  });

  // 命令类型
  describe('command classification', () => {
    const commandCases: string[] = ['马上去写作业！', '快走', '不准说话', '立刻过来'];

    it.each(commandCases)('should classify "%s" as 命令', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).toBe('命令');
    });
  });

  // 请求类型
  describe('request classification', () => {
    const requestCases: string[] = ['你能帮我拿一下书吗？', '请开门', '能不能借我一支笔', '麻烦帮个忙'];

    it.each(requestCases)('should classify "%s" as 请求', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).toBe('请求');
    });
  });

  // 叙事类型
  describe('narrative classification', () => {
    const narrativeCases: string[] = ['今天天气很好。', '他昨天去了上海', '你好啊'];

    it.each(narrativeCases)('should classify "%s" as 叙事', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).toBe('叙事');
    });
  });

  // 客套话不应被误判为命令
  describe('polite phrases exclusion', () => {
    const politeCases: string[] = ['别客气', '别介意', '别担心，没事的'];

    it.each(politeCases)('should NOT classify "%s" as 命令', (sentence) => {
      expect(classifySentenceWithEmoji(sentence).type).not.toBe('命令');
    });
  });

  // 颜文字前缀
  it('should include catchphrase prefix in emoji', () => {
    const result = classifySentenceWithEmoji('你好');
    expect(result.emoji.startsWith('叽 ')).toBe(true);
  });
});
