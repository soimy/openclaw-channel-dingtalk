import { describe, expect, it } from 'vitest';
import { getMainAgentId, resolveAtAgents } from '../../src/agent-name-matcher';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type { AtMention } from '../../src/types';

describe('agent-name-matcher', () => {
  describe('getMainAgentId', () => {
    it('returns "main" when agents list is empty', () => {
      expect(getMainAgentId(undefined)).toBe('main');
      expect(getMainAgentId([])).toBe('main');
    });

    it('returns default agent id when marked', () => {
      const agents = [
        { id: 'agent1', name: 'Agent 1' },
        { id: 'agent2', name: 'Agent 2', default: true },
      ];
      expect(getMainAgentId(agents)).toBe('agent2');
    });

    it('returns first agent id when no default marked', () => {
      const agents = [
        { id: 'agent1', name: 'Agent 1' },
        { id: 'agent2', name: 'Agent 2' },
      ];
      expect(getMainAgentId(agents)).toBe('agent1');
    });
  });

  describe('resolveAtAgents', () => {
    const cfg = {
      agents: {
        list: [
          { id: 'main', name: '助手', default: true },
          { id: 'ceresdb', name: 'CeresDB专家' },
          { id: 'dba', name: '数据库专家' },
        ],
      },
    } as OpenClawConfig;

    it('returns empty when no atMentions', () => {
      const result = resolveAtAgents([], cfg);
      expect(result.matchedAgents).toEqual([]);
      expect(result.unmatchedNames).toEqual([]);
    });

    it('matches by name field', () => {
      const atMentions: AtMention[] = [{ name: 'CeresDB专家' }];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe('ceresdb');
      expect(result.matchedAgents[0].matchSource).toBe('name');
    });

    it('matches by id field', () => {
      const atMentions: AtMention[] = [{ name: 'ceresdb' }];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe('ceresdb');
      expect(result.matchedAgents[0].matchSource).toBe('id');
    });

    it('matches case-insensitively', () => {
      const atMentions: AtMention[] = [{ name: 'CERESDB专家' }];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe('ceresdb');
    });

    it('excludes real users (with userId) from unmatched', () => {
      const atMentions: AtMention[] = [
        { name: '张三', userId: 'user123' },
        { name: 'notexist' },
      ];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.unmatchedNames).toEqual(['notexist']);
    });

    it('avoids duplicate matches', () => {
      const atMentions: AtMention[] = [
        { name: 'ceresdb' },
        { name: 'CeresDB专家' },
      ];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
    });

    it('returns mainAgentId', () => {
      const atMentions: AtMention[] = [{ name: 'ceresdb' }];
      const result = resolveAtAgents(atMentions, cfg);
      expect(result.mainAgentId).toBe('main');
    });

    it('handles missing agents config', () => {
      const atMentions: AtMention[] = [{ name: '张三' }];
      const result = resolveAtAgents(atMentions, {} as OpenClawConfig);
      expect(result.matchedAgents).toEqual([]);
      expect(result.unmatchedNames).toEqual(['张三']);
      expect(result.mainAgentId).toBe('main');
    });
  });
});