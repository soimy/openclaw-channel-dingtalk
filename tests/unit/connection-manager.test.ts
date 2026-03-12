import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, ReconnectDeadlineError } from '../../src/connection-manager';
import { ConnectionState } from '../../src/types';

/**
 * Helper: create a mock DWClient whose connect() creates a socket that opens
 * immediately (via microtask), matching real SDK behaviour where _connect()
 * resolves before the "open" event fires.
 */
function createMockClient(overrides?: Record<string, any>) {
    const socket = new EventEmitter();
    (socket as any).readyState = 1;
    (socket as any).removeListener = socket.removeListener.bind(socket);

    const client = {
        connected: false,
        registered: true,
        socket,
        connect: vi.fn().mockImplementation(async () => {
            client.socket = socket;
            queueMicrotask(() => {
                (socket as any).readyState = 1;
                client.connected = true;
                socket.emit('open');
            });
        }),
        disconnect: vi.fn(),
        ...overrides,
    } as any;

    return { client, socket };
}

/** Minimal config for tests that don't care about specific values. */
function baseConfig(overrides?: Record<string, any>) {
    return {
        maxAttempts: 3,
        initialDelay: 100,
        maxDelay: 1000,
        jitter: 0,
        ...overrides,
    };
}

describe('ConnectionManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    // ── Existing tests (adapted for socket open wait) ──────────────────

    it('connects successfully and updates state', async () => {
        const { client } = createMockClient();
        const onStateChange = vi.fn();

        const manager = new ConnectionManager(
            client, 'main', baseConfig({ onStateChange }), undefined,
        );

        await manager.connect();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(manager.isConnected()).toBe(true);
        expect(manager.getState()).toBe(ConnectionState.CONNECTED);
        expect(onStateChange).toHaveBeenCalledWith(ConnectionState.CONNECTING, undefined);
        expect(onStateChange).toHaveBeenCalledWith(ConnectionState.CONNECTED, undefined);
    });

    it('cleans up previous client resources before each connect attempt', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));

        await manager.connect();

        expect(client.disconnect).toHaveBeenCalledTimes(1);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(client.disconnect.mock.invocationCallOrder[0])
            .toBeLessThan(client.connect.mock.invocationCallOrder[0]);
    });

    it('logs debug and continues when pre-connect disconnect throws', async () => {
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const { client } = createMockClient({
            disconnect: vi.fn().mockImplementation(() => { throw new Error('pre-cleanup failed'); }),
        });

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }), log);

        await manager.connect();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('pre-connect'));
    });

    it('retries and eventually fails after max attempts', async () => {
        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockRejectedValue(new Error('connect failed')),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 2 }));

        const promise = manager.connect();
        const rejected = expect(promise).rejects.toThrow('Failed to connect after 2 attempts');
        await vi.advanceTimersByTimeAsync(120);

        await rejected;
        expect(client.connect).toHaveBeenCalledTimes(2);
        expect(manager.getState()).toBe(ConnectionState.FAILED);
    });

    it('handles runtime disconnection and schedules reconnect', async () => {
        const { client, socket } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Health check interval fires at 60s (HEALTH_CHECK_INTERVAL_MS), needs 2 consecutive unhealthy checks
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);
        // Immediate reconnect (delay=0) + microtask for socket open
        await vi.advanceTimersByTimeAsync(10);

        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not reconnect during the initial health check grace window', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 2 }));

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Grace window is 30s; advance to 15s (within grace) — no reconnect expected
        await vi.advanceTimersByTimeAsync(15000);
        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('stop disconnects client and resolves waitForStop', async () => {
        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig());

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
            registered: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));

        manager.stop();
        await expect(manager.connect()).rejects.toThrow('Cannot connect: connection manager is stopped');
    });

    it('handles disconnect throw inside stop gracefully', () => {
        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockImplementation(() => { throw new Error('disconnect failed'); }),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));

        expect(() => manager.stop()).not.toThrow();
        expect(manager.isStopped()).toBe(true);
    });

    it('cancels in-flight connect when stopped during connect', async () => {
        let resolveConnect: (() => void) | undefined;
        const connectPromise = new Promise<void>((resolve) => { resolveConnect = resolve; });

        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockImplementation(() => connectPromise),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig());

        const running = manager.connect();
        manager.stop();
        resolveConnect?.();

        await expect(running).rejects.toThrow('Connection cancelled: connection manager stopped');
        expect(client.disconnect).toHaveBeenCalled();
    });

    it('returns resolved waitForStop when already stopped', async () => {
        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn(),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));

        manager.stop();
        await expect(manager.waitForStop()).resolves.toBeUndefined();
    });

    it('reacts to socket close event by scheduling reconnect', async () => {
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const { client, socket } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 2 }), log);

        await manager.connect();
        socket.emit('close', 1006, 'lost');
        await vi.advanceTimersByTimeAsync(10);

        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Runtime counters (socket-close)'));
    });

    it('stops runtime reconnect loop when max reconnect cycles is reached', async () => {
        const { client, socket } = createMockClient();
        const onStateChange = vi.fn();

        // First connect succeeds, subsequent ones fail
        client.connect = vi.fn()
            .mockImplementationOnce(async () => {
                client.socket = socket;
                queueMicrotask(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                });
            })
            .mockRejectedValue(new Error('reconnect failed'));

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 1,
            maxReconnectCycles: 2,
            onStateChange,
        }));

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Health check at 60s intervals (HEALTH_CHECK_INTERVAL_MS), 2 consecutive unhealthy -> reconnect
        await vi.advanceTimersByTimeAsync(90000);
        await vi.advanceTimersByTimeAsync(60100);
        await vi.advanceTimersByTimeAsync(60100);

        expect(manager.getState()).toBe(ConnectionState.FAILED);
        expect(onStateChange).toHaveBeenCalledWith(
            ConnectionState.FAILED,
            'Max runtime reconnect cycles (2) reached',
        );
    });

    // ── Change 1: Zombie connection detection ──────────────────────────

    it('detects zombie connection: socket open but registered=false', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();

        // Simulate server-side logical disconnect: registered becomes false
        // but socket stays open (ping/pong still works)
        client.registered = false;
        client.connected = false;

        // Need 2 consecutive unhealthy checks (60s each), then immediate reconnect
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(10);

        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not false-trigger on normal connection (socket open + registered=true)', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();

        await vi.advanceTimersByTimeAsync(15000);

        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('does not false-trigger when connected=true but registered=false (server never sends REGISTERED)', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();

        // Some DingTalk configurations never send REGISTERED system message
        client.registered = false;
        // client.connected remains true — connection is healthy
        // Advance within grace window to verify no false-trigger (grace=30s)
        await vi.advanceTimersByTimeAsync(15000);

        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('does not false-trigger during grace window when registered is still false', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();

        // Simulate slow REGISTERED message: registered still false within grace window (30s)
        client.registered = false;

        await vi.advanceTimersByTimeAsync(15000);
        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    // ── Change 2: handleRuntimeDisconnection state guard ───────────────

    it('handleRuntimeDisconnection does not trigger when state is not CONNECTED', async () => {
        const { client, socket } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();
        manager.stop();

        // Try emitting close after stop — should not crash or trigger reconnect
        const connectCountBefore = client.connect.mock.calls.length;
        socket.emit('close', 1006, 'test');
        await vi.advanceTimersByTimeAsync(1000);
        expect(client.connect.mock.calls.length).toBe(connectCountBefore);
    });

    // ── Change 3: Heartbeat interval cleanup ───────────────────────────

    it('clears SDK heartbeatIntervallId before connect', async () => {
        const { client } = createMockClient();
        const fakeIntervalId = setInterval(() => {}, 99999);
        (client as any).heartbeatIntervallId = fakeIntervalId;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));

        await manager.connect();

        expect((client as any).heartbeatIntervallId).toBeUndefined();
        clearInterval(fakeIntervalId);
    });

    // ── Change 4: Reconnect deadline ───────────────────────────────────

    it('throws ReconnectDeadlineError when deadline is exceeded', async () => {
        const client = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockRejectedValue(new Error('connect failed')),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 10,
            reconnectDeadlineMs: 500,
        }));

        (manager as any).reconnectDeadline = Date.now() + 500;

        const promise = manager.connect();
        const rejectAssertion = expect(promise).rejects.toThrow('Reconnect deadline exceeded');
        await vi.advanceTimersByTimeAsync(600);
        manager.stop();
        await rejectAssertion;
    });

    it('first-time connect is not affected by deadline (reconnectDeadline is undefined)', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({
            reconnectDeadlineMs: 100,
        }));

        // reconnectDeadline is not set for first connect
        await manager.connect();
        expect(manager.isConnected()).toBe(true);
    });

    it('clears reconnectDeadline on successful reconnect', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({
            reconnectDeadlineMs: 50000,
        }));

        (manager as any).reconnectDeadline = Date.now() + 50000;

        await manager.connect();

        expect((manager as any).reconnectDeadline).toBeUndefined();
    });

    it('deadline timeout does not count as a reconnect cycle', async () => {
        const { client, socket } = createMockClient();

        let connectCount = 0;
        client.connect = vi.fn().mockImplementation(async () => {
            connectCount++;
            if (connectCount === 1) {
                client.socket = socket;
                queueMicrotask(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                });
            } else {
                throw new Error('connect failed');
            }
        });

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 1,
            reconnectDeadlineMs: 200,
            maxReconnectCycles: 1,
        }));

        await manager.connect();

        client.connected = false;
        client.registered = false;

        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(300);

        // Deadline exceeded does not count toward maxReconnectCycles,
        // so it should not be in terminal FAILED state from cycle exhaustion
        const state = manager.getState();
        expect(state).not.toBe(ConnectionState.CONNECTED);
        manager.stop();
    });

    // ── Change 5: Immediate first reconnect ────────────────────────────

    it('schedules immediate reconnect on runtime disconnection (delay=0)', async () => {
        const { client, socket } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const manager = new ConnectionManager(client, 'main', baseConfig(), log);

        await manager.connect();

        // Trigger disconnect via socket close
        socket.emit('close', 1006, 'test');

        expect(log.info).toHaveBeenCalledWith(
            expect.stringContaining('Scheduling immediate reconnection'),
        );
    });

    // ── Change 7: Wait for socket open ─────────────────────────────────

    it('waits for socket open before setting CONNECTED state', async () => {
        const socket = new EventEmitter();
        (socket as any).readyState = 0; // CONNECTING
        (socket as any).removeListener = socket.removeListener.bind(socket);

        const client = {
            connected: false,
            registered: true,
            socket,
            connect: vi.fn().mockImplementation(async () => {
                client.socket = socket;
                // Delay open event
                setTimeout(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                }, 500);
            }),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));
        const connectPromise = manager.connect();

        // Before open fires, should not be connected
        expect(manager.getState()).not.toBe(ConnectionState.CONNECTED);

        await vi.advanceTimersByTimeAsync(600);
        await connectPromise;

        expect(manager.isConnected()).toBe(true);
    });

    it('rejects when socket closes before open', async () => {
        const socket = new EventEmitter();
        (socket as any).readyState = 0;
        (socket as any).removeListener = socket.removeListener.bind(socket);

        const client = {
            connected: false,
            registered: false,
            socket,
            connect: vi.fn().mockImplementation(async () => {
                client.socket = socket;
                setTimeout(() => {
                    socket.emit('close');
                }, 100);
            }),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));
        const promise = manager.connect();
        const rejectAssertion = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(200);
        manager.stop();
        await rejectAssertion;
    });

    it('socket open timeout triggers retry', async () => {
        const socket = new EventEmitter();
        (socket as any).readyState = 0;
        (socket as any).removeListener = socket.removeListener.bind(socket);

        const client = {
            connected: false,
            registered: false,
            socket,
            connect: vi.fn().mockImplementation(async () => {
                client.socket = socket;
            }),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({ maxAttempts: 1 }));
        const promise = manager.connect();
        const rejectAssertion = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(11000);
        manager.stop();
        await rejectAssertion;
    });

    it('open timeout respects reconnectDeadline', async () => {
        const socket = new EventEmitter();
        (socket as any).readyState = 0;
        (socket as any).removeListener = socket.removeListener.bind(socket);

        const client = {
            connected: false,
            registered: false,
            socket,
            connect: vi.fn().mockImplementation(async () => {
                client.socket = socket;
            }),
            disconnect: vi.fn(),
        } as any;

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 1,
            reconnectDeadlineMs: 2000,
        }));

        (manager as any).reconnectDeadline = Date.now() + 2000;

        const promise = manager.connect();
        const rejectAssertion = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(2500);
        manager.stop();
        await rejectAssertion;
    });

    // ── Change 8: Cycle backoff cap ────────────────────────────────────

    it('cycle backoff does not exceed MAX_CYCLE_BACKOFF_MS', async () => {
        const { client, socket } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        client.connect = vi.fn()
            .mockImplementationOnce(async () => {
                client.socket = socket;
                queueMicrotask(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                });
            })
            .mockRejectedValue(new Error('reconnect failed'));

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 1,
            initialDelay: 10000,
            maxReconnectCycles: 10,
        }), log);

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Trigger health check disconnect (2x 60s interval needed)
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(200);

        // Check that the logged delay is <= 5 seconds
        const schedulingCalls = log.warn.mock.calls.filter(
            (c: string[]) => c[0]?.includes('scheduling next reconnect in'),
        );
        for (const call of schedulingCalls) {
            const match = call[0].match(/in (\d+\.\d+)s/);
            if (match) {
                expect(parseFloat(match[1])).toBeLessThanOrEqual(5.01);
            }
        }
    });

    // ── Change 9: stop() clears reconnectDeadline ──────────────────────

    it('stop clears reconnectDeadline', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();
        (manager as any).reconnectDeadline = Date.now() + 50000;

        manager.stop();

        expect((manager as any).reconnectDeadline).toBeUndefined();
    });

    // ── Change 10: stop() during deadline reconnect cancels it ─────────

    it('stop cancels in-progress deadline reconnection', async () => {
        const { client, socket } = createMockClient();

        client.connect = vi.fn()
            .mockImplementationOnce(async () => {
                client.socket = socket;
                queueMicrotask(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                });
            })
            .mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 60000));
            });

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 10,
            reconnectDeadlineMs: 1000,
        }));

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Health check -> reconnect attempt (2x 60s interval)
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(100);

        manager.stop();
        expect(manager.isStopped()).toBe(true);
        expect((manager as any).reconnectDeadline).toBeUndefined();
    });

    // ── Consecutive deadline timeout cap ───────────────────────────────

    it('enters FAILED state after MAX_CONSECUTIVE_DEADLINE_TIMEOUTS', async () => {
        const { client, socket } = createMockClient();
        const onStateChange = vi.fn();

        let connectCount = 0;
        client.connect = vi.fn().mockImplementation(async () => {
            connectCount++;
            if (connectCount === 1) {
                client.socket = socket;
                queueMicrotask(() => {
                    (socket as any).readyState = 1;
                    client.connected = true;
                    socket.emit('open');
                });
            } else {
                throw new Error('connect failed');
            }
        });

        const manager = new ConnectionManager(client, 'main', baseConfig({
            maxAttempts: 1,
            reconnectDeadlineMs: 100,
            maxReconnectCycles: 100,
            onStateChange,
        }));

        await manager.connect();
        client.connected = false;
        client.registered = false;

        // Health checks to detect disconnect (60s interval)
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(60000);

        // Each deadline cycle: ~100ms deadline + ~100ms backoff delay + retries
        // Run enough time for 5 consecutive deadline timeouts
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(5000);
        }

        expect(manager.getState()).toBe(ConnectionState.FAILED);
        expect(onStateChange).toHaveBeenCalledWith(
            ConnectionState.FAILED,
            expect.stringContaining('Max consecutive deadline timeouts'),
        );
    });

    it('resets consecutiveDeadlineTimeouts on successful reconnect', async () => {
        const { client } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig({
            reconnectDeadlineMs: 50000,
        }));

        // Simulate some deadline timeouts happened
        (manager as any).consecutiveDeadlineTimeouts = 3;
        (manager as any).reconnectDeadline = Date.now() + 50000;

        await manager.connect();

        expect((manager as any).consecutiveDeadlineTimeouts).toBe(0);
    });

    // ── Server disconnect system message detection ─────────────────────

    it('triggers immediate reconnection on server disconnect system message', async () => {
        const { client, socket } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const manager = new ConnectionManager(client, 'main', baseConfig(), log);

        await manager.connect();

        // Simulate server sending a disconnect system message
        const disconnectMsg = JSON.stringify({
            type: "SYSTEM",
            headers: { topic: "disconnect", contentType: "application/json" },
            data: '{"reason": "connection is expired"}',
        });
        socket.emit('message', disconnectMsg);

        // Should trigger immediate reconnection
        await vi.advanceTimersByTimeAsync(10);

        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('Server disconnect system message received'),
        );
        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not trigger reconnection on non-disconnect system messages', async () => {
        const { client, socket } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();
        const connectCountAfterInit = client.connect.mock.calls.length;

        // Simulate a ping system message (should not trigger reconnect)
        const pingMsg = JSON.stringify({
            type: "SYSTEM",
            headers: { topic: "ping", contentType: "application/json" },
            data: '{"opaque": "test-123"}',
        });
        socket.emit('message', pingMsg);

        await vi.advanceTimersByTimeAsync(1000);

        expect(client.connect.mock.calls.length).toBe(connectCountAfterInit);
    });

    // ── Warm reconnect (StreamClientFactory) ────────────────────────────

    it('warm reconnect uses factory to create new client and cleans up old one', async () => {
        const { client: oldClient, socket: oldSocket } = createMockClient();
        const { client: newClient, socket: newSocket } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const factory = vi.fn().mockReturnValue(newClient);

        const manager = new ConnectionManager(
            oldClient, 'main', baseConfig({ maxAttempts: 2 }), log, factory,
        );

        await manager.connect();

        expect(factory).toHaveBeenCalledTimes(1);
        expect(newClient.connect).toHaveBeenCalledTimes(1);
        // Old client should be disconnected during cleanup (not before connect)
        expect(oldClient.disconnect).toHaveBeenCalled();
        expect(manager.isConnected()).toBe(true);
        expect(log.info).toHaveBeenCalledWith(
            expect.stringContaining('Warm reconnect: created fresh DWClient'),
        );
    });

    it('warm reconnect falls back to old client when factory throws', async () => {
        const { client } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const factory = vi.fn().mockImplementation(() => {
            throw new Error('factory exploded');
        });

        const manager = new ConnectionManager(
            client, 'main', baseConfig({ maxAttempts: 1 }), log, factory,
        );

        await manager.connect();

        expect(factory).toHaveBeenCalledTimes(1);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(manager.isConnected()).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('Client factory failed, falling back'),
        );
    });

    it('warm reconnect reverts to old client when new client connect fails', async () => {
        const { client: oldClient } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const failingNewClient = {
            connected: false,
            registered: false,
            socket: undefined,
            connect: vi.fn().mockRejectedValue(new Error('new client connect failed')),
            disconnect: vi.fn(),
        } as any;

        const factory = vi.fn().mockReturnValue(failingNewClient);

        const manager = new ConnectionManager(
            oldClient, 'main', baseConfig({ maxAttempts: 1 }), log, factory,
        );

        await expect(manager.connect()).rejects.toThrow('Failed to connect after 1 attempts');

        expect(log.debug).toHaveBeenCalledWith(
            expect.stringContaining('Warm reconnect failed, reverted to previous client'),
        );
        // The internal client should have been reverted to oldClient
        expect(failingNewClient.disconnect).toHaveBeenCalled();
    });

    it('warm reconnect cleans up old client heartbeat timer', async () => {
        const { client: oldClient } = createMockClient();
        const { client: newClient } = createMockClient();

        const fakeIntervalId = setInterval(() => {}, 99999);
        (oldClient as any).heartbeatIntervallId = fakeIntervalId;

        const factory = vi.fn().mockReturnValue(newClient);

        const manager = new ConnectionManager(
            oldClient, 'main', baseConfig(), undefined, factory,
        );

        await manager.connect();

        expect((oldClient as any).heartbeatIntervallId).toBeUndefined();
        clearInterval(fakeIntervalId);
    });

    // ── Socket idle timeout ─────────────────────────────────────────────

    it('triggers reconnection when socket is idle for 60s', async () => {
        const { client, socket } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const manager = new ConnectionManager(client, 'main', baseConfig(), log);

        await manager.connect();

        // Advance past the grace window (3s) + enough health checks to reach 60s idle
        // Health checks run every 5s; at each check, idleMs = now - lastSocketActivityAt.
        // lastSocketActivityAt is set to Date.now() on connect. After 60s of no
        // socket message events, the idle threshold is met.
        await vi.advanceTimersByTimeAsync(61_000);

        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('Socket idle for'),
        );
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('treating as zombie connection'),
        );
        // Should have attempted reconnection
        expect(client.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not trigger idle timeout when socket receives messages', async () => {
        const { client, socket } = createMockClient();

        const manager = new ConnectionManager(client, 'main', baseConfig());

        await manager.connect();
        const connectCountAfterInit = client.connect.mock.calls.length;

        // Simulate periodic messages arriving every 20s (within 60s threshold)
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(20_000);
            const keepaliveMsg = JSON.stringify({
                type: "SYSTEM",
                headers: { topic: "KEEPALIVE" },
                data: "",
            });
            socket.emit('message', keepaliveMsg);
        }

        // 100s total have passed, but no 60s idle window ever occurred
        expect(client.connect.mock.calls.length).toBe(connectCountAfterInit);
    });

    it('idle timeout counter is tracked in runtimeCounters', async () => {
        const { client } = createMockClient();
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        const manager = new ConnectionManager(client, 'main', baseConfig(), log);

        await manager.connect();

        await vi.advanceTimersByTimeAsync(61_000);

        expect(log.info).toHaveBeenCalledWith(
            expect.stringContaining('socketIdleReconnects=1'),
        );
    });
});
