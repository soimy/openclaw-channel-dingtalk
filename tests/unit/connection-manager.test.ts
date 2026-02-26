import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/connection-manager';
import { ConnectionState } from '../../src/types';

describe('ConnectionManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('connects successfully and updates state', async () => {
        const socket = new EventEmitter();
        const client = {
            connected: true,
            socket,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const onStateChange = vi.fn();

        const manager = new ConnectionManager(
            client,
            'main',
            {
                maxAttempts: 3,
                initialDelay: 100,
                maxDelay: 1000,
                jitter: 0,
                onStateChange,
            },
            undefined
        );

        await manager.connect();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(manager.isConnected()).toBe(true);
        expect(manager.getState()).toBe(ConnectionState.CONNECTED);
        expect(onStateChange).toHaveBeenCalledWith(ConnectionState.CONNECTING, undefined);
        expect(onStateChange).toHaveBeenCalledWith(ConnectionState.CONNECTED, undefined);
    });

    it('retries and eventually fails after max attempts', async () => {
        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn().mockRejectedValue(new Error('connect failed')),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 2,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        const promise = manager.connect();
        const rejected = expect(promise).rejects.toThrow('Failed to connect after 2 attempts');
        await vi.advanceTimersByTimeAsync(120);

        await rejected;
        expect(client.connect).toHaveBeenCalledTimes(2);
        expect(manager.getState()).toBe(ConnectionState.FAILED);
    });

    it('handles runtime disconnection and schedules reconnect', async () => {
        const socket = new EventEmitter();
        const client = {
            connected: true,
            socket,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 3,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        await manager.connect();
        client.connected = false;

        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(120);

        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not reconnect during the initial health check grace window', async () => {
        const socket = new EventEmitter();
        const client = {
            connected: true,
            socket,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 2,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        await manager.connect();
        client.connected = false;

        await vi.advanceTimersByTimeAsync(2500);
        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('stop disconnects client and resolves waitForStop', async () => {
        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 3,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        const waitPromise = manager.waitForStop();
        manager.stop();

        await expect(waitPromise).resolves.toBeUndefined();
        expect(client.disconnect).toHaveBeenCalledTimes(1);
        expect(manager.isStopped()).toBe(true);
        expect(manager.getState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('throws when connect is called after stop', async () => {
        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 1,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        manager.stop();
        await expect(manager.connect()).rejects.toThrow('Cannot connect: connection manager is stopped');
    });

    it('handles disconnect throw inside stop gracefully', () => {
        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockImplementation(() => {
                throw new Error('disconnect failed');
            }),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 1,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        expect(() => manager.stop()).not.toThrow();
        expect(manager.isStopped()).toBe(true);
    });

    it('cancels in-flight connect when stopped during connect', async () => {
        let resolveConnect: ((value?: void | PromiseLike<void>) => void) | undefined;
        const connectPromise = new Promise<void>((resolve) => {
            resolveConnect = resolve;
        });

        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn().mockImplementation(() => connectPromise),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 3,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        const running = manager.connect();
        manager.stop();
        resolveConnect?.();

        await expect(running).rejects.toThrow('Connection cancelled: connection manager stopped');
        expect(client.disconnect).toHaveBeenCalled();
    });

    it('returns resolved waitForStop when already stopped', async () => {
        const client = {
            connected: false,
            socket: undefined,
            connect: vi.fn(),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 1,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        });

        manager.stop();
        await expect(manager.waitForStop()).resolves.toBeUndefined();
    });

    it('reacts to socket close event by scheduling reconnect', async () => {
        const socket = new EventEmitter();
        const log = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        const client = {
            connected: true,
            socket,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 2,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
        }, log);

        await manager.connect();
        socket.emit('close', 1006, 'lost');
        await vi.advanceTimersByTimeAsync(120);

        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Runtime counters (socket-close)'));
    });

    it('stops runtime reconnect loop when max reconnect cycles is reached', async () => {
        const socket = new EventEmitter();
        const onStateChange = vi.fn();
        const client = {
            connected: true,
            socket,
            connect: vi
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValue(new Error('reconnect failed')),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', {
            maxAttempts: 1,
            initialDelay: 100,
            maxDelay: 1000,
            jitter: 0,
            maxReconnectCycles: 2,
            onStateChange,
        });

        await manager.connect();
        client.connected = false;

        await vi.advanceTimersByTimeAsync(10000);
        await vi.advanceTimersByTimeAsync(300);

        expect(client.connect).toHaveBeenCalledTimes(3);
        expect(manager.getState()).toBe(ConnectionState.FAILED);
        expect(onStateChange).toHaveBeenCalledWith(
            ConnectionState.FAILED,
            'Max runtime reconnect cycles (2) reached'
        );

        await vi.advanceTimersByTimeAsync(5000);
        expect(client.connect).toHaveBeenCalledTimes(3);
    });
});
