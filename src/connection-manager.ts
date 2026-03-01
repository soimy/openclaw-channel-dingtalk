/**
 * Connection Manager for DingTalk Stream Client
 *
 * Provides robust connection lifecycle management with:
 * - Exponential backoff with jitter for reconnection attempts
 * - Configurable max attempts and delay parameters
 * - Connection state tracking and event handling
 * - Proper cleanup of timers and resources
 * - Structured logging for all connection events
 */

import type { DWClient } from "dingtalk-stream";
import type {
  ConnectionState,
  ConnectionManagerConfig,
  ConnectionAttemptResult,
  Logger,
} from "./types";
import { ConnectionState as ConnectionStateEnum } from "./types";

/**
 * ConnectionManager handles the robust connection lifecycle for DWClient
 */
export class ConnectionManager {
  private config: ConnectionManagerConfig;
  private log?: Logger;
  private accountId: string;

  // Connection state tracking
  private state: ConnectionState = ConnectionStateEnum.DISCONNECTED;
  private attemptCount: number = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped: boolean = false;
  private connectedAt?: number;
  private consecutiveUnhealthyChecks: number = 0;

  private static readonly HEALTH_CHECK_INTERVAL_MS = 5000;
  private static readonly HEALTH_CHECK_GRACE_MS = 3000;
  private static readonly HEALTH_CHECK_UNHEALTHY_THRESHOLD = 2;
  private static readonly DEFAULT_MAX_RECONNECT_CYCLES = 10;
  private runtimeReconnectCycles: number = 0;
  private runtimeCounters = {
    healthUnhealthyChecks: 0,
    healthTriggeredReconnects: 0,
    socketCloseEvents: 0,
    runtimeDisconnects: 0,
    reconnectAttempts: 0,
    reconnectSuccess: 0,
    reconnectFailures: 0,
  };

  // Runtime monitoring resources
  private healthCheckInterval?: NodeJS.Timeout;
  private socketCloseHandler?: (code: number, reason: string) => void;
  private socketErrorHandler?: (error: Error) => void;
  private monitoredSocket?: any; // Store the socket instance we attached listeners to

  // Sleep abort control
  private sleepTimeout?: NodeJS.Timeout;
  private sleepResolve?: () => void;

  // Stop signal for waitForStop()
  private stopPromiseResolvers: Array<() => void> = [];

  // Client reference
  private client: DWClient;

  constructor(client: DWClient, accountId: string, config: ConnectionManagerConfig, log?: Logger) {
    this.client = client;
    this.accountId = accountId;
    this.config = config;
    this.log = log;
  }

  private notifyStateChange(error?: string): void {
    if (this.config.onStateChange) {
      this.config.onStateChange(this.state, error);
    }
  }

  private logRuntimeCounters(reason: string): void {
    const c = this.runtimeCounters;
    this.log?.info?.(
      `[${this.accountId}] Runtime counters (${reason}): healthUnhealthyChecks=${c.healthUnhealthyChecks}, healthTriggeredReconnects=${c.healthTriggeredReconnects}, socketCloseEvents=${c.socketCloseEvents}, runtimeDisconnects=${c.runtimeDisconnects}, reconnectAttempts=${c.reconnectAttempts}, reconnectSuccess=${c.reconnectSuccess}, reconnectFailures=${c.reconnectFailures}`,
    );
  }

  /**
   * Calculate next reconnection delay with exponential backoff and jitter
   * Formula: delay = min(initialDelay * 2^attempt, maxDelay) * (1 ± jitter)
   * @param attempt Zero-based attempt number (0 for first retry, 1 for second, etc.)
   */
  private calculateNextDelay(attempt: number): number {
    const { initialDelay, maxDelay, jitter } = this.config;

    // Exponential backoff: initialDelay * 2^attempt
    // For attempt=0 (first retry), this gives initialDelay * 1 = initialDelay
    const exponentialDelay = initialDelay * Math.pow(2, attempt);

    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, maxDelay);

    // Apply jitter: randomize ± jitter%
    const jitterAmount = cappedDelay * jitter;
    const randomJitter = (Math.random() * 2 - 1) * jitterAmount;
    const finalDelay = Math.max(100, cappedDelay + randomJitter); // Minimum 100ms

    return Math.floor(finalDelay);
  }

  /**
   * Attempt to connect with retry logic
   */
  private async attemptConnection(): Promise<ConnectionAttemptResult> {
    if (this.stopped) {
      return {
        success: false,
        attempt: this.attemptCount,
        error: new Error("Connection manager stopped"),
      };
    }

    this.attemptCount++;
    this.state = ConnectionStateEnum.CONNECTING;
    this.notifyStateChange();

    this.log?.info?.(
      `[${this.accountId}] Connection attempt ${this.attemptCount}/${this.config.maxAttempts}...`,
    );

    try {
      // Ensure previous connection resources (heartbeat timers, old sockets) are
      // fully cleaned up before establishing a new connection.  The DWClient
      // _connect() method does not clear its internal heartbeat interval, so a
      // stale timer from a prior session can terminate the newly created socket
      // before it finishes the handshake (manifests as code-1006 / "WebSocket was
      // closed before the connection was established").
      try {
        this.client.disconnect();
      } catch (disconnectErr: any) {
        this.log?.debug?.(
          `[${this.accountId}] pre-connect cleanup disconnect failed: ${disconnectErr.message}`,
        );
      }

      await this.client.connect();

      // Re-check stopped flag after async connect() completes
      // This prevents race condition where stop() is called during connection
      if (this.stopped) {
        this.log?.warn?.(
          `[${this.accountId}] Connection succeeded but manager was stopped during connect - disconnecting`,
        );
        try {
          this.client.disconnect();
        } catch (disconnectErr: any) {
          this.log?.debug?.(
            `[${this.accountId}] Error during post-connect disconnect: ${disconnectErr.message}`,
          );
        }
        return {
          success: false,
          attempt: this.attemptCount,
          error: new Error("Connection manager stopped during connect"),
        };
      }

      // Connection successful
      this.state = ConnectionStateEnum.CONNECTED;
      this.connectedAt = Date.now();
      this.consecutiveUnhealthyChecks = 0;
      this.notifyStateChange();
      const successfulAttempt = this.attemptCount;
      this.attemptCount = 0; // Reset counter on success

      this.log?.info?.(`[${this.accountId}] DingTalk Stream client connected successfully`);

      // Reset runtime reconnect cycle counter on successful connection
      this.runtimeReconnectCycles = 0;

      return { success: true, attempt: successfulAttempt };
    } catch (err: any) {
      this.log?.error?.(
        `[${this.accountId}] Connection attempt ${this.attemptCount} failed: ${err.message}`,
      );

      // Check if we've exceeded max attempts
      if (this.attemptCount >= this.config.maxAttempts) {
        this.state = ConnectionStateEnum.FAILED;
        this.notifyStateChange("Max connection attempts reached");
        this.log?.error?.(
          `[${this.accountId}] Max connection attempts (${this.config.maxAttempts}) reached. Giving up.`,
        );
        return { success: false, attempt: this.attemptCount, error: err };
      }

      // Calculate next retry delay (use attemptCount-1 for zero-based exponent)
      // This ensures first retry uses 2^0 = 1x initialDelay
      const nextDelay = this.calculateNextDelay(this.attemptCount - 1);

      this.log?.warn?.(
        `[${this.accountId}] Will retry connection in ${(nextDelay / 1000).toFixed(2)}s (attempt ${this.attemptCount + 1}/${this.config.maxAttempts})`,
      );

      return { success: false, attempt: this.attemptCount, error: err, nextDelay };
    }
  }

  /**
   * Connect with robust retry logic
   */
  public async connect(): Promise<void> {
    if (this.stopped) {
      throw new Error("Cannot connect: connection manager is stopped");
    }

    // Clear any existing reconnect timer
    this.clearReconnectTimer();

    this.log?.info?.(
      `[${this.accountId}] Starting DingTalk Stream client with robust connection...`,
    );

    // Keep trying until success or max attempts reached
    while (!this.stopped && this.state !== ConnectionStateEnum.CONNECTED) {
      const result = await this.attemptConnection();

      if (result.success) {
        // Connection successful
        this.setupRuntimeReconnection();
        return;
      }

      // Check if connection was stopped during connect
      if (result.error?.message === "Connection manager stopped during connect") {
        this.log?.info?.(
          `[${this.accountId}] Connection cancelled: manager stopped during connect`,
        );
        throw new Error("Connection cancelled: connection manager stopped");
      }

      if (!result.nextDelay || this.attemptCount >= this.config.maxAttempts) {
        // No more retries
        throw new Error(`Failed to connect after ${this.attemptCount} attempts`);
      }

      // Wait before next attempt
      await this.sleep(result.nextDelay);
    }
  }

  /**
   * Setup runtime reconnection handlers
   * Monitors DWClient connection state for automatic reconnection
   */
  private setupRuntimeReconnection(): void {
    this.log?.debug?.(`[${this.accountId}] Setting up runtime reconnection monitoring`);

    // Clean up any existing monitoring resources before setting up new ones
    this.cleanupRuntimeMonitoring();

    // Access DWClient internals to monitor connection state
    const client = this.client as any;

    // Monitor client's 'connected' property changes
    // We'll set up an interval to periodically check connection health
    this.healthCheckInterval = setInterval(() => {
      if (this.stopped) {
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
        }
        return;
      }

      if (this.state !== ConnectionStateEnum.CONNECTED) {
        this.consecutiveUnhealthyChecks = 0;
        return;
      }

      const now = Date.now();
      const withinGraceWindow =
        this.connectedAt !== undefined &&
        now - this.connectedAt < ConnectionManager.HEALTH_CHECK_GRACE_MS;
      if (withinGraceWindow) {
        this.consecutiveUnhealthyChecks = 0;
        return;
      }

      const socketReadyState = (client.socket as { readyState?: number } | undefined)?.readyState;
      const socketOpen = socketReadyState === 1;
      const unhealthy = !client.connected && !socketOpen;

      if (!unhealthy) {
        this.consecutiveUnhealthyChecks = 0;
        return;
      }

      this.consecutiveUnhealthyChecks += 1;
      this.runtimeCounters.healthUnhealthyChecks += 1;
      if (
        this.consecutiveUnhealthyChecks <
        ConnectionManager.HEALTH_CHECK_UNHEALTHY_THRESHOLD
      ) {
        this.log?.debug?.(
          `[${this.accountId}] Connection health check unhealthy (${this.consecutiveUnhealthyChecks}/${ConnectionManager.HEALTH_CHECK_UNHEALTHY_THRESHOLD}) connected=${String(client.connected)} socketReadyState=${socketReadyState ?? "unknown"}`,
        );
        return;
      }

      this.log?.warn?.(
        `[${this.accountId}] Connection health check failed - detected disconnection`,
      );
      this.runtimeCounters.healthTriggeredReconnects += 1;
      this.logRuntimeCounters("health-triggered-reconnect");
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }
      this.handleRuntimeDisconnection();
    }, ConnectionManager.HEALTH_CHECK_INTERVAL_MS);

    // Additionally, if we have access to the socket, monitor its events
    // The DWClient uses 'ws' WebSocket library which extends EventEmitter
    if (client.socket) {
      const socket = client.socket;
      // Store the socket instance we're attaching listeners to
      this.monitoredSocket = socket;

      // Handler for socket close event
      this.socketCloseHandler = (code: number, reason: string) => {
        this.runtimeCounters.socketCloseEvents += 1;
        this.log?.warn?.(
          `[${this.accountId}] WebSocket closed event (code: ${code}, reason: ${reason || "none"})`,
        );
        this.logRuntimeCounters("socket-close");

        // Only trigger reconnection if we were previously connected and not stopping
        if (!this.stopped && this.state === ConnectionStateEnum.CONNECTED) {
          if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
          }
          this.handleRuntimeDisconnection();
        }
      };

      // Handler for socket error event
      this.socketErrorHandler = (error: Error) => {
        this.log?.error?.(
          `[${this.accountId}] WebSocket error event: ${error?.message || "Unknown error"}`,
        );
      };

      // Listen to socket events
      // Use 'once' for close to avoid duplicate reconnection triggers
      socket.once("close", this.socketCloseHandler);
      // Use 'once' for error as well to prevent accumulation across reconnects
      socket.once("error", this.socketErrorHandler);
    }
  }

  /**
   * Clean up runtime monitoring resources (intervals and event listeners)
   */
  private cleanupRuntimeMonitoring(): void {
    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      this.log?.debug?.(`[${this.accountId}] Health check interval cleared`);
    }

    // Remove socket event listeners from the stored socket instance
    if (this.monitoredSocket) {
      const socket = this.monitoredSocket;

      if (this.socketCloseHandler) {
        socket.removeListener("close", this.socketCloseHandler);
        this.socketCloseHandler = undefined;
      }
      if (this.socketErrorHandler) {
        socket.removeListener("error", this.socketErrorHandler);
        this.socketErrorHandler = undefined;
      }

      this.log?.debug?.(`[${this.accountId}] Socket event listeners removed from monitored socket`);
      this.monitoredSocket = undefined;
    }
  }

  /**
   * Handle runtime disconnection and trigger reconnection
   */
  private handleRuntimeDisconnection(): void {
    if (this.stopped) {
      return;
    }

    this.log?.warn?.(
      `[${this.accountId}] Runtime disconnection detected, initiating reconnection...`,
    );
    this.runtimeCounters.runtimeDisconnects += 1;

    this.state = ConnectionStateEnum.DISCONNECTED;
    this.notifyStateChange("Runtime disconnection detected");
    this.attemptCount = 0; // Reset attempt counter for runtime reconnection
    this.connectedAt = undefined;
    this.consecutiveUnhealthyChecks = 0;

    // Clear any existing timer
    this.clearReconnectTimer();

    // Start reconnection with initial delay
    const delay = this.calculateNextDelay(0);
    this.log?.info?.(
      `[${this.accountId}] Scheduling reconnection in ${(delay / 1000).toFixed(2)}s`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch((err) => {
        this.log?.error?.(`[${this.accountId}] Reconnection failed: ${err.message}`);
      });
    }, delay);
  }

  /**
   * Reconnect after runtime disconnection
   */
  private async reconnect(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.log?.info?.(`[${this.accountId}] Attempting to reconnect...`);
    this.runtimeCounters.reconnectAttempts += 1;

    try {
      await this.connect();
      this.log?.info?.(`[${this.accountId}] Reconnection successful`);
      this.runtimeCounters.reconnectSuccess += 1;
      this.logRuntimeCounters("reconnect-success");
    } catch (err: any) {
      if (this.stopped) {
        return;
      }

      this.log?.error?.(`[${this.accountId}] Reconnection failed: ${err.message}`);
      this.runtimeCounters.reconnectFailures += 1;
      this.logRuntimeCounters("reconnect-failed");

      // Track runtime reconnect cycles to prevent infinite loops
      this.runtimeReconnectCycles += 1;
      const maxCycles = this.config.maxReconnectCycles ?? ConnectionManager.DEFAULT_MAX_RECONNECT_CYCLES;

      if (this.runtimeReconnectCycles >= maxCycles) {
        this.log?.error?.(
          `[${this.accountId}] Max runtime reconnect cycles (${maxCycles}) reached. Giving up. ` +
          `Please check network connectivity or restart the gateway.`,
        );
        this.state = ConnectionStateEnum.FAILED;
        this.connectedAt = undefined;
        this.consecutiveUnhealthyChecks = 0;
        this.notifyStateChange(`Max runtime reconnect cycles (${maxCycles}) reached`);
        return;
      }

      this.state = ConnectionStateEnum.FAILED;
      this.connectedAt = undefined;
      this.consecutiveUnhealthyChecks = 0;
      this.notifyStateChange(err.message);

      // Continue runtime recovery with exponential backoff based on cycle count
      const delay = this.calculateNextDelay(Math.min(this.runtimeReconnectCycles - 1, 6)); // Cap at ~64x initial delay
      this.attemptCount = 0;
      this.clearReconnectTimer();
      this.log?.warn?.(
        `[${this.accountId}] Reconnection cycle ${this.runtimeReconnectCycles}/${maxCycles} failed; scheduling next reconnect in ${(delay / 1000).toFixed(2)}s`,
      );
      this.reconnectTimer = setTimeout(() => {
        void this.reconnect();
      }, delay);
    }
  }

  /**
   * Stop the connection manager and cleanup resources
   */
  public stop(): void {
    if (this.stopped) {
      return;
    }

    this.log?.info?.(`[${this.accountId}] Stopping connection manager...`);

    this.stopped = true;
    this.state = ConnectionStateEnum.DISCONNECTING;
    this.connectedAt = undefined;
    this.consecutiveUnhealthyChecks = 0;

    // Clear reconnect timer
    this.clearReconnectTimer();

    // Cancel any in-flight sleep (retry delay)
    this.cancelSleep();

    // Clean up runtime monitoring resources
    this.cleanupRuntimeMonitoring();

    // Disconnect client
    try {
      this.client.disconnect();
    } catch (err: any) {
      this.log?.warn?.(`[${this.accountId}] Error during disconnect: ${err.message}`);
    }

    this.state = ConnectionStateEnum.DISCONNECTED;
    this.log?.info?.(`[${this.accountId}] Connection manager stopped`);

    // Resolve all pending waitForStop() promises
    for (const resolve of this.stopPromiseResolvers) {
      resolve();
    }
    this.stopPromiseResolvers = [];
  }

  /**
   * Returns a Promise that resolves when the connection manager is stopped.
   * Useful for keeping a caller alive (e.g. startAccount) until the channel
   * is explicitly stopped via stop() or an abort signal handler that calls stop().
   * Safe to call concurrently; all pending callers are resolved when stop() is called.
   */
  public waitForStop(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.stopPromiseResolvers.push(resolve);
    });
  }

  /**
   * Clear reconnection timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.log?.debug?.(`[${this.accountId}] Reconnect timer cleared`);
    }
  }

  /**
   * Sleep utility for retry delays
   * Returns a promise that resolves after ms or can be cancelled via cancelSleep()
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimeout = setTimeout(() => {
        this.sleepTimeout = undefined;
        this.sleepResolve = undefined;
        resolve();
      }, ms);
    });
  }

  /**
   * Cancel any in-flight sleep operation
   * Resolves the pending promise immediately so await unblocks
   */
  private cancelSleep(): void {
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = undefined;
      this.log?.debug?.(`[${this.accountId}] Sleep timeout cancelled`);
    }
    // Resolve the pending promise so await unblocks immediately
    if (this.sleepResolve) {
      this.sleepResolve();
      this.sleepResolve = undefined;
    }
  }

  /**
   * Get current connection state
   */
  public getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connection is active
   */
  public isConnected(): boolean {
    return this.state === ConnectionStateEnum.CONNECTED;
  }

  /**
   * Check if connection manager is stopped
   */
  public isStopped(): boolean {
    return this.stopped;
  }
}
