import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadDedupModule() {
    vi.resetModules();
    return import('../../src/dedup');
}

describe('message dedup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-21T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('marks and detects processed messages inside ttl', async () => {
        const dedup = await loadDedupModule();

        expect(dedup.isMessageProcessed('robot:msg_1')).toBe(false);
        dedup.markMessageProcessed('robot:msg_1');
        expect(dedup.isMessageProcessed('robot:msg_1')).toBe(true);
    });

    it('expires processed messages after ttl', async () => {
        const dedup = await loadDedupModule();

        dedup.markMessageProcessed('robot:msg_2');
        vi.advanceTimersByTime(60_001);

        expect(dedup.isMessageProcessed('robot:msg_2')).toBe(false);
    });

    it('keeps latest entries when map grows beyond max size', async () => {
        const dedup = await loadDedupModule();

        for (let i = 0; i < 1005; i++) {
            dedup.markMessageProcessed(`robot:burst_${i}`);
        }

        expect(dedup.isMessageProcessed('robot:burst_1004')).toBe(true);
    });
});
