# DingTalk Connection Troubleshooting Implementation Plan

> Note: This implementation plan is intended to be followed task by task by engineers implementing the DingTalk connection troubleshooting workflow.

**Goal:** Improve DingTalk connection-init diagnostics by logging structured startup failures, adding minimal cross-platform `connections/open` diagnostic scripts, and documenting the troubleshooting workflow.

**Architecture:** Keep the upstream `dingtalk-stream` SDK untouched and improve observability at the plugin boundary. Reuse existing DingTalk error-payload formatting helpers in `src/utils.ts`, add standalone shell/PowerShell scripts under `scripts/`, and route users from `README.md` to a dedicated troubleshooting manual.

**Tech Stack:** TypeScript, Vitest, Node.js scripts, Bash, PowerShell, README/docs markdown, existing `axios`-style error handling helpers.

---

### Task 1: Add failing tests for connection-init error logging

**Files:**
- Modify: `tests/unit/connection-manager.test.ts`
- Read for context: `src/connection-manager.ts`
- Read for helper behavior: `src/utils.ts`

**Step 1: Write the failing tests**

Add tests that assert:

1. When `client.connect()` rejects with an Axios-shaped error containing `response.status`, `response.data.code`, `response.data.message`, and `response.headers["x-acs-dingtalk-request-id"]`, the logger records a structured message instead of only the generic `err.message`.
2. When `client.connect()` rejects with a plain `Error`, logging still falls back to the generic message.

Test shape to add:

```ts
it('logs structured DingTalk payload details for startup 400 failures', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const err = Object.assign(new Error('Request failed with status code 400'), {
        response: {
            status: 400,
            data: { code: 'invalidParameter', message: 'ua invalid' },
            headers: { 'x-acs-dingtalk-request-id': 'req-123' },
        },
    });
    const client = {
        connected: false,
        socket: undefined,
        connect: vi.fn().mockRejectedValue(err),
        disconnect: vi.fn(),
    } as any;

    const manager = new ConnectionManager(client, 'main', {
        maxAttempts: 1,
        initialDelay: 100,
        maxDelay: 1000,
        jitter: 0,
    }, log);

    await expect(manager.connect()).rejects.toThrow('Failed to connect after 1 attempts');

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('status=400'));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('requestId=req-123'));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('code=invalidParameter'));
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/connection-manager.test.ts`

Expected: FAIL because the current logger only emits the generic connection-attempt error message.

**Step 3: Write minimal implementation**

Do not change tests yet. Implement only enough production code to satisfy the structured logging expectations.

**Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/connection-manager.test.ts`

Expected: PASS for the new logging tests and existing connection-manager tests.

### Task 2: Implement structured connection-init logging

**Files:**
- Modify: `src/connection-manager.ts`
- Modify if needed for helper reuse: `src/utils.ts`
- Test: `tests/unit/connection-manager.test.ts`

**Step 1: Add a connection-error formatter helper**

Introduce a small helper in `src/connection-manager.ts` or `src/utils.ts` that:

- detects Axios-like `response.status`, `response.data`, and `response.headers`
- extracts DingTalk request ID from common header keys
- formats a single safe log line reusing `formatDingTalkErrorPayload(...)`
- includes a stage label such as `connect.open`

Suggested output pattern:

```ts
`[${this.accountId}] Connection attempt ${this.attemptCount} failed: ${err.message} [DingTalk][connect.open] status=400 requestId=req-123 code=invalidParameter message=ua invalid payload={...}`
```

**Step 2: Keep generic fallback behavior**

If no structured response exists, continue to log only the generic message.

**Step 3: Add user guidance to the error line**

Append a short hint to run the diagnostic script / troubleshooting doc only when a structured 4xx/5xx response exists.

**Step 4: Re-run tests**

Run: `pnpm test tests/unit/connection-manager.test.ts`

Expected: PASS.

### Task 3: Add the Bash diagnostic script

**Files:**
- Create: `scripts/dingtalk-connection-check.sh`
- Read for scripting conventions: `scripts/dingtalk-stream-monitor.mjs`
- Read for config shape: `src/types.ts`

**Step 1: Write the script contract first in comments / usage text**

Usage must support:

```bash
./scripts/dingtalk-connection-check.sh --client-id xxx --client-secret yyy
./scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json
./scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json --account-id main
```

**Step 2: Implement argument parsing**

Support:

- `--client-id`
- `--client-secret`
- `--config`
- `--account-id`
- `--help`

**Step 3: Implement config resolution**

Resolution order:

1. explicit args
2. config file from `--config`
3. default `~/.openclaw/openclaw.json`

Lookup behavior:

- default: `channels.dingtalk.clientId/clientSecret`
- with `--account-id`: matching entry under `channels.dingtalk.accounts`

Use Node or Python as a JSON extraction helper only if necessary, but keep the script itself bash-first and dependency-light.

**Step 4: Implement the request**

Call:

```bash
curl -sS -X POST "https://api.dingtalk.com/v1.0/gateway/connections/open" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --data '{"clientId":"...","clientSecret":"...","subscriptions":[{"type":"CALLBACK","topic":"/v1.0/im/bot/messages/get"}]}'
```

The script must emit:

- masked `clientId`
- masked config source
- HTTP status
- sanitized response body
- masked `ticket` if present

**Step 5: Manually test script help and an expected failure path**

Run:

- `bash scripts/dingtalk-connection-check.sh --help`
- `bash scripts/dingtalk-connection-check.sh --client-id fake --client-secret fake`

Expected: no secret leakage; failure output is readable.

### Task 4: Add the PowerShell diagnostic script

**Files:**
- Create: `scripts/dingtalk-connection-check.ps1`
- Mirror behavior from: `scripts/dingtalk-connection-check.sh`

**Step 1: Match the Bash script interface**

Support:

- `-ClientId`
- `-ClientSecret`
- `-Config`
- `-AccountId`
- `-Help`

**Step 2: Implement config and credential resolution**

Use PowerShell JSON parsing (`Get-Content | ConvertFrom-Json`) to read `openclaw.json`.

**Step 3: Implement `connections/open` request**

Use `Invoke-RestMethod` or `Invoke-WebRequest` with explicit JSON body and headers.

**Step 4: Sanitize all output**

Mask:

- `clientSecret`
- `ticket`
- any secret-like values echoed back

**Step 5: Verify help path syntax**

Run: `pwsh -File scripts/dingtalk-connection-check.ps1 -Help`

Expected: prints usage without errors.

### Task 5: Add troubleshooting docs and README entry points

**Files:**
- Create: `docs/connection-troubleshooting.md`
- Modify: `README.md`

**Step 1: Write the troubleshooting manual**

Document:

- what init-time HTTP 400 usually means
- why it is different from generic timeout/DNS/TLS failures
- how to run both scripts
- how default-account vs `accountId` lookup works
- how to read success/failure output
- what to do when `connections/open` succeeds but plugin init still fails

That last section must tell users to check:

- proxy / company gateway
- WSS access
- DingTalk app publication state
- robot capability and Stream mode settings
- account/config mismatch between the script and the plugin runtime

**Step 2: Update the README connection-failure section**

Replace the current short checklist with:

- a short explanation that `400` is not always just network reachability
- a link to `docs/connection-troubleshooting.md`
- a note that the scripts exist under `scripts/`

**Step 3: Proofread examples for path accuracy**

Make sure every command shown actually matches repository paths and file names.

### Task 6: Final verification

**Files:**
- Verify all modified files

**Step 1: Run targeted tests**

Run: `pnpm test tests/unit/connection-manager.test.ts`

Expected: PASS.

**Step 2: Run type-check**

Run: `npm run type-check`

Expected: exit code 0.

**Step 3: Run lint**

Run: `npm run lint`

Expected: exit code 0.

**Step 4: Spot-check script UX**

Run:

- `bash scripts/dingtalk-connection-check.sh --help`
- `pwsh -File scripts/dingtalk-connection-check.ps1 -Help`

Expected: both print valid usage text.

**Step 5: Review changed files**

Confirm:

- no secrets are logged or hardcoded
- docs reference the right script names
- log messages stay consistent with existing repo style
