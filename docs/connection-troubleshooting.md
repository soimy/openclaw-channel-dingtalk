# DingTalk Connection Troubleshooting

This guide focuses on startup-time DingTalk Stream connection failures, especially cases that only show `400` during plugin initialization.

## What HTTP 400 Usually Means

For DingTalk Stream startup, HTTP `400` usually means DingTalk accepted the request and rejected its contents. It is not the same as generic network failures such as:

- DNS resolution failure
- TCP timeout
- TLS handshake failure
- proxy or firewall drops before the request reaches DingTalk

That distinction matters because:

- `400` often points to credentials, app state, request shape, or platform-side validation.
- timeout/TLS/DNS failures point to local network, proxy, or outbound access issues.

## First Step: Run the Minimal Connection Check

These scripts only test:

`POST https://api.dingtalk.com/v1.0/gateway/connections/open`

They do **not** test the later WebSocket handshake. That is intentional: the first goal is to separate `connections/open` failures from later WSS/proxy failures.

### macOS / Linux

```bash
bash scripts/dingtalk-connection-check.sh --client-id <clientId> --client-secret <clientSecret>
```

Or read from OpenClaw config:

```bash
bash scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json
```

For a multi-account setup:

```bash
bash scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json --account-id main
```

### Windows PowerShell

```powershell
pwsh -File scripts/dingtalk-connection-check.ps1 -ClientId <clientId> -ClientSecret <clientSecret>
```

Or read from OpenClaw config:

```powershell
pwsh -File scripts/dingtalk-connection-check.ps1 -Config ~/.openclaw/openclaw.json
```

For a multi-account setup:

```powershell
pwsh -File scripts/dingtalk-connection-check.ps1 -Config ~/.openclaw/openclaw.json -AccountId main
```

## Credential Resolution Rules

Both scripts follow the same order:

1. explicit credentials passed by CLI
2. config file passed with `--config` / `-Config`
3. default `~/.openclaw/openclaw.json`

Config lookup rules:

- default account: `channels.dingtalk.clientId` / `channels.dingtalk.clientSecret`
- specific account: `channels.dingtalk.accounts.<accountId>`

This is important when troubleshooting multi-account setups: make sure the script and the running plugin are using the same account.

## How to Read the Output

Example success output:

```text
DingTalk connection check
credential_source=account:main
config_path=/Users/you/.openclaw/openclaw.json
account_id=main
client_id=ding...1234
http_status=200
response={"endpoint":"wss://wss-open-connection.dingtalk.com:443/connect","ticket":"7724...aee6"}
endpoint=wss://wss-open-connection.dingtalk.com:443/connect
ticket=7724...aee6
```

Example failure output:

```text
DingTalk connection check
credential_source=default
config_path=/Users/you/.openclaw/openclaw.json
account_id=
client_id=ding...1234
http_status=400
response={"code":"invalidParameter","message":"ua invalid","requestId":"abc123"}
```

Notes:

- secrets are masked by design
- `ticket` is masked by design
- `endpoint` is safe to share in normal issue reports

## Interpreting the Result

### Case 1: `connections/open` returns `400`

Likely causes:

- wrong `clientId` / `clientSecret`
- app state problem in DingTalk platform
- unsupported or rejected request payload
- app not published, bot capability missing, or Stream mode not enabled

Check these first:

- DingTalk app is an internal enterprise app
- DingTalk Console → Version Management → Published → Version Details: Visibility Scope is set to "All employees"
- Ensure there is a published version (not draft) for the internal app/robot
- robot capability is enabled
- message receive mode is Stream mode
- current app version is published
- the credentials in the script match the actual plugin runtime config

### Case 2: `connections/open` returns `200`, but plugin startup still fails

This is the most important split.

If `connections/open` succeeds, then:

- the credentials are at least good enough for the open call
- basic HTTPS reachability to `api.dingtalk.com` is working
- the remaining problem is more likely in the later WebSocket phase or in an environment difference between the script and the plugin runtime

Check next:

- corporate proxy or gateway interfering with WSS
- outbound access to `wss-open-connection.dingtalk.com:443`
- TLS interception / SSL MITM products
- Node runtime environment variables like `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
- whether the plugin process and the shell script are truly running on the same machine / container / network path

Example websocket-stage log snippet:

```text
[main] Failed to establish connection: Unexpected server response: 400 [DingTalk][ConnectionError][connect.websocket] endpoint=wss://wss-open-connection.dingtalk.com:443/connect Likely websocket/proxy/WSS issue after connections/open succeeded See docs/connection-troubleshooting.md or run scripts/dingtalk-connection-check.*
```

### Case 3: no HTTP status / transport failure

If the script cannot produce a real HTTP status, investigate:

- DNS resolution
- outbound firewall rules
- proxy configuration
- TLS certificate trust

## What the Plugin Now Logs

Startup failures now try to include more detail when DingTalk returns a structured error response, for example:

- HTTP status
- connection stage
- DingTalk `code`
- DingTalk `message`
- request ID
- sanitized error payload

### Stage meanings

- `connect.open`: failure happened while requesting `POST /v1.0/gateway/connections/open`
- `connect.websocket`: `connections/open` already succeeded, but the later WebSocket connection still failed

This split is useful because:

- `connect.open` usually points you back to credentials, app state, Stream mode setup, or DingTalk request validation.
- `connect.websocket` points much more strongly to WSS reachability, proxy behavior, TLS interception, or corporate gateway policy.

If you see `connect.websocket` together with an endpoint like `wss://wss-open-connection.dingtalk.com/...`, prioritize checking:

- outbound WSS access on port 443
- proxy `Upgrade` / WebSocket support
- SSL MITM / security products
- whether the plugin process is running behind a different proxy path than your manual shell test

Required endpoints to reach:
- `https://api.dingtalk.com:443` (open stage)
- `wss://wss-open-connection.dingtalk.com:443` (websocket stage)

## User-side settings checklist (DingTalk Console)

- Enterprise internal app/robot has a published version (not only in draft)
- Version Management → Published → Version Details → Visibility Scope: All employees
- Robot capability is enabled
- Message receive mode: Stream mode

If you open an issue, include:

- the plugin startup error line
- the output of one of the connection-check scripts
- whether you are using default account config or a named `accountId`

## Related Files

- `scripts/dingtalk-connection-check.sh`
- `scripts/dingtalk-connection-check.ps1`
- `src/connection-manager.ts`
- `README.md`
Proxy notes:
- Scripts inherit HTTP_PROXY / HTTPS_PROXY / NO_PROXY from your environment.
- For WebSocket (WSS) testing, ensure your proxy/gateway supports Upgrade and TLS pass-through.
