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

import type { DWClient } from 'dingtalk-stream';
import type { ConnectionState, ConnectionManagerConfig, ConnectionAttemptResult, Logger } from './types';
import { ConnectionState as ConnectionStateEnum } from './types';

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
  
  // Client reference
  private client: DWClient;
  
  constructor(
    client: DWClient,
    accountId: string,
    config: ConnectionManagerConfig,
    log?: Logger
  ) {
    this.client = client;
    this.accountId = accountId;
    this.config = config;
    this.log = log;
  }

  /**
   * Calculate next reconnection delay with exponential backoff and jitter
   * Formula: delay = min(initialDelay * 2^attempt, maxDelay) * (1 ± jitter)
   */
  private calculateNextDelay(attempt: number): number {
    const { initialDelay, maxDelay, jitter } = this.config;
    
    // Exponential backoff: initialDelay * 2^attempt
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
      return { success: false, attempt: this.attemptCount, error: new Error('Connection manager stopped') };
    }

    this.attemptCount++;
    this.state = ConnectionStateEnum.CONNECTING;
    
    this.log?.info?.(
      `[${this.accountId}] Connection attempt ${this.attemptCount}/${this.config.maxAttempts}...`
    );

    try {
      // Call DWClient connect method
      await this.client.connect();
      
      // Connection successful
      this.state = ConnectionStateEnum.CONNECTED;
      this.attemptCount = 0; // Reset counter on success
      
      this.log?.info?.(
        `[${this.accountId}] DingTalk Stream client connected successfully`
      );
      
      return { success: true, attempt: this.attemptCount };
    } catch (err: any) {
      this.log?.error?.(
        `[${this.accountId}] Connection attempt ${this.attemptCount} failed: ${err.message}`
      );
      
      // Check if we've exceeded max attempts
      if (this.attemptCount >= this.config.maxAttempts) {
        this.state = ConnectionStateEnum.FAILED;
        this.log?.error?.(
          `[${this.accountId}] Max connection attempts (${this.config.maxAttempts}) reached. Giving up.`
        );
        return { success: false, attempt: this.attemptCount, error: err };
      }
      
      // Calculate next retry delay
      const nextDelay = this.calculateNextDelay(this.attemptCount);
      
      this.log?.warn?.(
        `[${this.accountId}] Will retry connection in ${(nextDelay / 1000).toFixed(2)}s (attempt ${this.attemptCount + 1}/${this.config.maxAttempts})`
      );
      
      return { success: false, attempt: this.attemptCount, error: err, nextDelay };
    }
  }

  /**
   * Connect with robust retry logic
   */
  public async connect(): Promise<void> {
    if (this.stopped) {
      throw new Error('Cannot connect: connection manager is stopped');
    }

    // Clear any existing reconnect timer
    this.clearReconnectTimer();
    
    this.log?.info?.(`[${this.accountId}] Starting DingTalk Stream client with robust connection...`);
    
    // Keep trying until success or max attempts reached
    while (!this.stopped && this.state !== ConnectionStateEnum.CONNECTED) {
      const result = await this.attemptConnection();
      
      if (result.success) {
        // Connection successful
        this.setupRuntimeReconnection();
        return;
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
    
    // Access DWClient internals to monitor connection state
    const client = this.client as any;
    
    // Monitor client's 'connected' property changes
    // We'll set up an interval to periodically check connection health
    const healthCheckInterval = setInterval(() => {
      if (this.stopped) {
        clearInterval(healthCheckInterval);
        return;
      }
      
      // If we believe we're connected but DWClient disagrees, trigger reconnection
      if (this.state === ConnectionStateEnum.CONNECTED && !client.connected) {
        this.log?.warn?.(
          `[${this.accountId}] Connection health check failed - detected disconnection`
        );
        clearInterval(healthCheckInterval);
        this.handleRuntimeDisconnection();
      }
    }, 5000); // Check every 5 seconds
    
    // Store interval ID for cleanup
    (this as any).healthCheckInterval = healthCheckInterval;
    
    // Additionally, if we have access to the socket, monitor its events
    // The DWClient uses 'ws' WebSocket library which extends EventEmitter
    if (client.socket) {
      const socket = client.socket;
      
      // Handler for socket close event
      const onSocketClose = (code: number, reason: string) => {
        this.log?.warn?.(
          `[${this.accountId}] WebSocket closed event (code: ${code}, reason: ${reason || 'none'})`
        );
        
        // Only trigger reconnection if we were previously connected and not stopping
        if (!this.stopped && this.state === ConnectionStateEnum.CONNECTED) {
          clearInterval(healthCheckInterval);
          this.handleRuntimeDisconnection();
        }
      };
      
      // Handler for socket error event
      const onSocketError = (error: Error) => {
        this.log?.error?.(
          `[${this.accountId}] WebSocket error event: ${error?.message || 'Unknown error'}`
        );
      };
      
      // Listen to socket events
      // Use 'once' for close to avoid duplicate reconnection triggers
      socket.once('close', onSocketClose);
      socket.on('error', onSocketError);
      
      // Store handlers for cleanup
      (this as any).socketCloseHandler = onSocketClose;
      (this as any).socketErrorHandler = onSocketError;
    }
  }

  /**
   * Handle runtime disconnection and trigger reconnection
   */
  private handleRuntimeDisconnection(): void {
    if (this.stopped) return;
    
    this.log?.warn?.(`[${this.accountId}] Runtime disconnection detected, initiating reconnection...`);
    
    this.state = ConnectionStateEnum.DISCONNECTED;
    this.attemptCount = 0; // Reset attempt counter for runtime reconnection
    
    // Clear any existing timer
    this.clearReconnectTimer();
    
    // Start reconnection with initial delay
    const delay = this.calculateNextDelay(0);
    this.log?.info?.(`[${this.accountId}] Scheduling reconnection in ${(delay / 1000).toFixed(2)}s`);
    
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
    if (this.stopped) return;
    
    this.log?.info?.(`[${this.accountId}] Attempting to reconnect...`);
    
    try {
      await this.connect();
      this.log?.info?.(`[${this.accountId}] Reconnection successful`);
    } catch (err: any) {
      this.log?.error?.(`[${this.accountId}] Reconnection failed: ${err.message}`);
      this.state = ConnectionStateEnum.FAILED;
    }
  }

  /**
   * Stop the connection manager and cleanup resources
   */
  public stop(): void {
    if (this.stopped) return;
    
    this.log?.info?.(`[${this.accountId}] Stopping connection manager...`);
    
    this.stopped = true;
    this.state = ConnectionStateEnum.DISCONNECTING;
    
    // Clear reconnect timer
    this.clearReconnectTimer();
    
    // Clear health check interval
    const healthCheckInterval = (this as any).healthCheckInterval;
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      (this as any).healthCheckInterval = undefined;
      this.log?.debug?.(`[${this.accountId}] Health check interval cleared`);
    }
    
    // Remove socket event listeners if they exist
    const client = this.client as any;
    if (client.socket) {
      const socket = client.socket;
      const closeHandler = (this as any).socketCloseHandler;
      const errorHandler = (this as any).socketErrorHandler;
      
      if (closeHandler) {
        socket.removeListener('close', closeHandler);
        (this as any).socketCloseHandler = undefined;
      }
      if (errorHandler) {
        socket.removeListener('error', errorHandler);
        (this as any).socketErrorHandler = undefined;
      }
      
      this.log?.debug?.(`[${this.accountId}] Socket event listeners removed`);
    }
    
    // Disconnect client
    try {
      this.client.disconnect();
    } catch (err: any) {
      this.log?.warn?.(`[${this.accountId}] Error during disconnect: ${err.message}`);
    }
    
    this.state = ConnectionStateEnum.DISCONNECTED;
    this.log?.info?.(`[${this.accountId}] Connection manager stopped`);
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
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
