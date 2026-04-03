import { describe, expect, it } from 'vitest';
import { resolveCardStreamingMode } from '../../src/card/card-streaming-mode';

describe('resolveCardStreamingMode', () => {
    it('prefers explicit cardStreamingMode over deprecated cardRealTimeStream', () => {
        expect(resolveCardStreamingMode({ cardStreamingMode: 'answer', cardRealTimeStream: true }))
            .toEqual({ mode: 'answer', usedDeprecatedCardRealTimeStream: false });
    });

    it('maps legacy cardRealTimeStream=true to all when mode is absent', () => {
        expect(resolveCardStreamingMode({ cardRealTimeStream: true }))
            .toEqual({ mode: 'all', usedDeprecatedCardRealTimeStream: true });
    });

    it('defaults to off when both fields are absent', () => {
        expect(resolveCardStreamingMode({}))
            .toEqual({ mode: 'off', usedDeprecatedCardRealTimeStream: false });
    });
});
