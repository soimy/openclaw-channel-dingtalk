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
   * Monitors socket close and error events for automatic reconnection
   */
  private setupRuntimeReconnection(): void {
    // Access the internal socket from DWClient
    // Note: This uses private API access, but DWClient already has autoReconnect logic
    // We're enhancing it with our robust retry mechanism
    const client = this.client as any;
    
    if (client.socket) {
      this.log?.debug?.(`[${this.accountId}] Setting up runtime reconnection handlers`);
      
      // Monitor for disconnections
      const originalOnClose = client.socket.onclose;
      client.socket.onclose = (event: any) => {
        this.log?.warn?.(
          `[${this.accountId}] WebSocket closed (code: ${event?.code}, reason: ${event?.reason})`
        );
        
        // Trigger reconnection if not stopped
        if (!this.stopped && this.state === ConnectionStateEnum.CONNECTED) {
          this.handleRuntimeDisconnection();
        }
        
        // Call original handler if exists
        if (originalOnClose) {
          originalOnClose.call(client.socket, event);
        }
      };
      
      // Monitor for errors
      const originalOnError = client.socket.onerror;
      client.socket.onerror = (error: any) => {
        this.log?.error?.(
          `[${this.accountId}] WebSocket error: ${error?.message || 'Unknown error'}`
        );
        
        // Call original handler if exists
        if (originalOnError) {
          originalOnError.call(client.socket, error);
        }
      };
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
