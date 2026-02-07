/**
 * Manual Test Guide for Connection Robustness
 * 
 * This file provides instructions for manually testing the connection robustness implementation.
 * These tests cannot be automated without a test DingTalk environment.
 */

## Test Scenarios

### 1. Startup Connection with Invalid Credentials

**Purpose**: Verify exponential backoff and max attempts behavior

**Setup**:
```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "invalid-client-id",
      "clientSecret": "invalid-secret",
      "maxConnectionAttempts": 5,
      "initialReconnectDelay": 1000,
      "maxReconnectDelay": 10000,
      "reconnectJitter": 0.3,
      "debug": true
    }
  }
}
```

**Steps**:
1. Start OpenClaw gateway with the above config
2. Observe connection attempts in logs

**Expected Behavior**:
- Should see 5 connection attempts (maxConnectionAttempts)
- Delays should increase: ~1s, ~2s, ~4s, ~8s, ~10s (capped at maxReconnectDelay)
- After 5 attempts, should log "Max connection attempts reached" and stop
- No zombie processes should remain

**Log Pattern**:
```
[account-id] Connection attempt 1/5...
[account-id] Connection attempt 1 failed: ...
[account-id] Will retry connection in 1.20s (attempt 2/5)
[account-id] Connection attempt 2/5...
[account-id] Connection attempt 2 failed: ...
[account-id] Will retry connection in 2.35s (attempt 3/5)
...
[account-id] Max connection attempts (5) reached. Giving up.
```

---

### 2. Startup Connection Success

**Purpose**: Verify successful connection and monitoring setup

**Setup**: Use valid DingTalk credentials

**Steps**:
1. Configure with valid credentials
2. Start OpenClaw gateway
3. Check logs for successful connection

**Expected Behavior**:
- Connection should succeed on first or second attempt
- Should see "DingTalk Stream client connected successfully"
- Should see "Setting up runtime reconnection monitoring"
- Health check interval should be running

**Log Pattern**:
```
[account-id] Initializing DingTalk Stream client...
[account-id] Connection config: maxAttempts=10, initialDelay=1000ms, maxDelay=60000ms, jitter=0.3
[account-id] Starting DingTalk Stream client with robust connection...
[account-id] Connection attempt 1/10...
[account-id] DingTalk Stream client connected successfully
[account-id] Setting up runtime reconnection monitoring
```

---

### 3. Runtime Network Interruption

**Purpose**: Verify automatic reconnection during operation

**Setup**: Valid credentials with connection established

**Steps**:
1. Establish successful connection
2. Simulate network interruption:
   - Disconnect network cable
   - OR disable WiFi
   - OR use firewall to block DingTalk API endpoints
3. Wait for disconnection detection
4. Restore network connection
5. Observe automatic reconnection

**Expected Behavior**:
- Health check (every 5s) or socket close event detects disconnection
- Logs "Connection health check failed - detected disconnection"
- Automatic reconnection starts with retry logic
- Connection is restored when network is available
- Message processing resumes normally

**Log Pattern**:
```
[account-id] WebSocket closed event (code: 1006, reason: none)
[account-id] Connection health check failed - detected disconnection
[account-id] Runtime disconnection detected, initiating reconnection...
[account-id] Scheduling reconnection in 1.15s
[account-id] Attempting to reconnect...
[account-id] Connection attempt 1/10...
[account-id] DingTalk Stream client connected successfully
[account-id] Reconnection successful
```

---

### 4. Graceful Shutdown

**Purpose**: Verify proper cleanup on stop/abort

**Setup**: Valid credentials with connection established

**Steps**:
1. Establish successful connection
2. Stop OpenClaw gateway: `openclaw gateway stop`
3. Check logs for cleanup messages
4. Verify no processes remain: `ps aux | grep dingtalk`

**Expected Behavior**:
- Should log "Stopping connection manager..."
- Health check interval should be cleared
- Socket event listeners should be removed
- Reconnect timers should be cleared
- Client should disconnect gracefully
- No zombie Node.js processes

**Log Pattern**:
```
[account-id] Stopping connection manager...
[account-id] Health check interval cleared
[account-id] Socket event listeners removed
[account-id] Connection manager stopped
[account-id] DingTalk Stream client stopped
```

---

### 5. Abort Signal Handling

**Purpose**: Verify proper cleanup on abort signal

**Setup**: Valid credentials with connection established

**Steps**:
1. Establish successful connection
2. Send abort signal (Ctrl+C or SIGTERM)
3. Check logs for abort handling
4. Verify cleanup completed

**Expected Behavior**:
- Should log "Abort signal received"
- Should trigger stop() method
- All cleanup should execute as in Test 4

**Log Pattern**:
```
[account-id] Abort signal received, stopping DingTalk Stream client...
[account-id] Stopping connection manager...
[account-id] Health check interval cleared
[account-id] Socket event listeners removed
[account-id] Connection manager stopped
```

---

### 6. Custom Configuration Parameters

**Purpose**: Verify configuration parameters work as expected

**Setup**:
```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "valid-client-id",
      "clientSecret": "valid-secret",
      "maxConnectionAttempts": 3,
      "initialReconnectDelay": 2000,
      "maxReconnectDelay": 20000,
      "reconnectJitter": 0.5,
      "debug": true
    }
  }
}
```

**Steps**:
1. Configure with custom parameters
2. Trigger connection failure (invalid network, etc.)
3. Observe retry behavior

**Expected Behavior**:
- Should only attempt 3 times (maxConnectionAttempts=3)
- Initial delay should be ~2s (initialReconnectDelay=2000)
- Delays should cap at ~20s (maxReconnectDelay=20000)
- Jitter should be more pronounced (±50% vs ±30%)

**Log Pattern**:
```
[account-id] Connection config: maxAttempts=3, initialDelay=2000ms, maxDelay=20000ms, jitter=0.5
[account-id] Connection attempt 1/3...
[account-id] Will retry connection in 2.75s (attempt 2/3)
[account-id] Connection attempt 2/3...
[account-id] Will retry connection in 5.20s (attempt 3/3)
[account-id] Connection attempt 3/3...
[account-id] Max connection attempts (3) reached. Giving up.
```

---

### 7. Concurrent Message Processing During Reconnection

**Purpose**: Verify messages are not lost during reconnection

**Setup**: Valid credentials, simulate disconnection during active conversation

**Steps**:
1. Establish connection and start a conversation
2. During the conversation, simulate network interruption
3. While disconnected, send messages from DingTalk client
4. Restore network connection
5. Verify messages are processed after reconnection

**Expected Behavior**:
- Connection should automatically reconnect
- DingTalk will buffer messages during disconnection
- After reconnection, buffered messages should be delivered
- All messages should be processed without loss

---

### 8. Stress Test: Multiple Disconnection/Reconnection Cycles

**Purpose**: Verify stability over multiple connection cycles

**Setup**: Valid credentials

**Steps**:
1. Establish connection
2. Trigger 10 disconnection/reconnection cycles:
   - Disconnect network
   - Wait for reconnection
   - Verify successful reconnection
   - Repeat
3. Check for memory leaks or resource exhaustion

**Expected Behavior**:
- All cycles should complete successfully
- No increase in memory usage
- No accumulation of zombie timers or listeners
- Logs should be consistent across cycles

---

## Validation Checklist

After running the test scenarios, verify:

- [ ] Exponential backoff works correctly (delays increase exponentially)
- [ ] Jitter is applied (delays vary randomly within expected range)
- [ ] Max attempts is respected (stops after configured attempts)
- [ ] Max delay cap is enforced (delays don't exceed max)
- [ ] Successful connections proceed to monitoring setup
- [ ] Runtime disconnections trigger automatic reconnection
- [ ] Health check interval detects connection state changes
- [ ] Socket event listeners detect close and error events
- [ ] Stop/abort properly cleans up all resources
- [ ] No zombie processes or timers remain after shutdown
- [ ] Configuration parameters work as expected
- [ ] Logging is appropriate and helpful for debugging
- [ ] Messages are not lost during reconnection
- [ ] Memory usage is stable over multiple cycles

---

## Debugging Tips

1. **Enable debug logging**: Set `debug: true` in configuration
2. **Check logs**: Look for structured log messages with [account-id] prefix
3. **Monitor process**: Use `ps aux | grep node` to check for zombie processes
4. **Network tools**: Use `tcpdump` or Wireshark to inspect WebSocket traffic
5. **DingTalk console**: Check DingTalk developer console for server-side logs
6. **Timer inspection**: Use Node.js `process._getActiveHandles()` to check for active timers

---

## Common Issues

### Connection fails immediately
- Check credentials (clientId, clientSecret)
- Verify network connectivity to DingTalk API
- Check firewall rules

### Reconnection doesn't trigger
- Verify autoReconnect is disabled in DWClient
- Check health check interval is running
- Verify socket event listeners are attached

### Zombie processes remain
- Check stop() method is called
- Verify all clearInterval calls execute
- Check event listeners are removed

### Memory leaks
- Check for unclosed timers in stop()
- Verify event listeners are properly removed
- Use Node.js `--inspect` and Chrome DevTools for memory profiling
