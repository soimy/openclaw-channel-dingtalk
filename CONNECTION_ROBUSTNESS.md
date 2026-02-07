# DingTalk Connection Robustness Implementation

## Overview

This implementation adds comprehensive connection lifecycle management to the DingTalk Stream channel, ensuring reliable connectivity through:

1. **Exponential Backoff with Jitter**: Intelligent retry delays that prevent thundering herd problems
2. **Configurable Parameters**: Customizable retry attempts, delays, and jitter
3. **Automatic Runtime Reconnection**: Detects and recovers from connection failures during operation
4. **Proper Resource Cleanup**: Ensures no zombie timers or listeners on shutdown
5. **Structured Logging**: Detailed logs at appropriate levels for operational visibility

## Configuration Parameters

Add these optional parameters to your DingTalk channel configuration:

```yaml
channels:
  dingtalk:
    clientId: "your-client-id"
    clientSecret: "your-client-secret"
    
    # Connection robustness settings (all optional with sensible defaults)
    maxConnectionAttempts: 10          # Max retry attempts before giving up (default: 10)
    initialReconnectDelay: 1000        # Initial retry delay in ms (default: 1000)
    maxReconnectDelay: 60000          # Max retry delay cap in ms (default: 60000)
    reconnectJitter: 0.3              # Jitter factor 0-1 (default: 0.3)
```

### Parameter Details

- **maxConnectionAttempts**: Maximum number of connection attempts before declaring failure. After this many failures, the connection manager will stop trying and report an error.

- **initialReconnectDelay**: Starting delay (in milliseconds) before the first retry attempt. Each subsequent retry doubles this delay (exponential backoff).

- **maxReconnectDelay**: Maximum delay (in milliseconds) between retry attempts. The exponential backoff is capped at this value to prevent excessively long waits.

- **reconnectJitter**: Random variation factor (0-1) applied to retry delays. This prevents multiple clients from reconnecting simultaneously. A value of 0.3 means delays will vary by ±30%.

## Retry Delay Calculation

The retry delay follows this formula:

```
delay = min(initialDelay × 2^attempt, maxDelay) × (1 ± jitter)
```

Example with default settings:
- Attempt 1: ~1s (1000ms ± 30%)
- Attempt 2: ~2s (2000ms ± 30%)
- Attempt 3: ~4s (4000ms ± 30%)
- Attempt 4: ~8s (8000ms ± 30%)
- Attempt 5: ~16s (16000ms ± 30%)
- Attempt 6: ~32s (32000ms ± 30%)
- Attempt 7+: ~60s (capped at maxReconnectDelay ± 30%)

## Connection Lifecycle States

The `ConnectionManager` tracks connection state through these phases:

1. **DISCONNECTED**: Initial state or after deliberate disconnect
2. **CONNECTING**: Attempting to establish connection
3. **CONNECTED**: Successfully connected and operational
4. **DISCONNECTING**: Graceful shutdown in progress
5. **FAILED**: Max attempts exceeded, manual intervention required

## Logging

All connection events are logged with appropriate levels:

- **INFO**: Normal lifecycle events (connecting, connected, stopping)
- **WARN**: Retriable errors (connection failed, will retry)
- **ERROR**: Serious errors (max attempts exceeded, unexpected errors)
- **DEBUG**: Detailed internal state (socket events, config details)

Example log output:
```
[account-id] Initializing DingTalk Stream client...
[account-id] Connection config: maxAttempts=10, initialDelay=1000ms, maxDelay=60000ms, jitter=0.3
[account-id] Starting DingTalk Stream client with robust connection...
[account-id] Connection attempt 1/10...
[account-id] DingTalk Stream client connected successfully
[account-id] Setting up runtime reconnection monitoring
```

## Runtime Reconnection

When a connection drops during normal operation:

1. **Detection**: Health checks (every 5s) and socket event listeners detect disconnection
2. **Reconnection**: Automatic reconnection triggered with retry logic
3. **Recovery**: On success, normal message processing resumes
4. **Failure**: After max attempts, connection enters FAILED state and stops trying

## Shutdown and Cleanup

On stop/abort:

1. All reconnection timers are cleared
2. Socket event listeners are removed
3. Health check interval is stopped
4. Client socket is disconnected
5. Connection state transitions to DISCONNECTED

This ensures no "zombie" processes remain after shutdown.

## Implementation Details

### Key Files

- **src/config-schema.ts**: Configuration schema with connection parameters
- **src/types.ts**: TypeScript type definitions for connection management
- **src/connection-manager.ts**: Core ConnectionManager class implementation
- **src/channel.ts**: Integration point in startAccount function

### Architecture

```
startAccount (channel.ts)
    ↓
ConnectionManager.connect()
    ↓
[Retry Loop with Exponential Backoff]
    ↓
DWClient.connect()
    ↓
[Setup Runtime Monitoring]
    ↓
Health Checks + Socket Event Listeners
    ↓
[On Disconnect] → handleRuntimeDisconnection()
    ↓
ConnectionManager.reconnect()
```

### Backward Compatibility

The implementation is fully backward compatible:

- All new parameters are optional with sensible defaults
- Existing configurations work without modification
- Normal stop/start/abort workflows unchanged
- Only connection lifecycle management is enhanced

## Testing Recommendations

To validate the implementation:

1. **Startup Failures**: Test with invalid credentials to verify retry logic
2. **Network Issues**: Simulate network interruption during operation
3. **Stop/Abort**: Verify clean shutdown without zombie processes
4. **Logging**: Check log output at different levels (debug, info, warn, error)
5. **Config Variations**: Test with different parameter values

## Future Enhancements

Potential improvements for future versions:

- Exponential backoff per connection failure reason (e.g., different delays for auth vs network errors)
- Connection quality metrics and reporting
- Circuit breaker pattern for persistent failures
- Adaptive jitter based on cluster size
- Connection pooling for high-throughput scenarios
