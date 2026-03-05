import { describe, expect, it, beforeEach } from 'vitest';
import { acquireSessionLock, _getLocksMapForTest } from '../../src/session-lock';

describe('session-lock', () => {
    beforeEach(() => {
        _getLocksMapForTest().clear();
    });

    it('same key executes serially', async () => {
        const order: number[] = [];

        const releaseA = await acquireSessionLock('s1');
        const promiseB = (async () => {
            const releaseB = await acquireSessionLock('s1');
            order.push(2);
            releaseB();
        })();

        // B should be blocked while A holds the lock.
        await new Promise((r) => setTimeout(r, 20));
        expect(order).toEqual([]);

        order.push(1);
        releaseA();
        await promiseB;

        expect(order).toEqual([1, 2]);
    });

    it('different keys execute in parallel', async () => {
        const order: string[] = [];

        const releaseA = await acquireSessionLock('s1');
        const releaseB = await acquireSessionLock('s2');

        order.push('A');
        order.push('B');

        releaseA();
        releaseB();

        expect(order).toEqual(['A', 'B']);
    });

    it('cleans up map entry after last release', async () => {
        const locks = _getLocksMapForTest();

        const release = await acquireSessionLock('s1');
        expect(locks.has('s1')).toBe(true);

        release();
        expect(locks.has('s1')).toBe(false);
    });

    it('queues multiple waiters and processes in order', async () => {
        const order: number[] = [];

        const releaseA = await acquireSessionLock('s1');

        const promiseB = (async () => {
            const release = await acquireSessionLock('s1');
            order.push(2);
            release();
        })();

        const promiseC = (async () => {
            const release = await acquireSessionLock('s1');
            order.push(3);
            release();
        })();

        order.push(1);
        releaseA();

        await promiseB;
        await promiseC;

        expect(order).toEqual([1, 2, 3]);
    });

    it('releases lock even if caller throws after acquire', async () => {
        const locks = _getLocksMapForTest();

        const releaseA = await acquireSessionLock('s1');
        try {
            throw new Error('simulated crash');
        } catch {
            // expected
        } finally {
            releaseA();
        }

        expect(locks.has('s1')).toBe(false);

        const releaseB = await acquireSessionLock('s1');
        releaseB();
        expect(locks.has('s1')).toBe(false);
    });
});
