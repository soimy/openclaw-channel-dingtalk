/**
 * Covers `scripts/clawhub-publication-state.mjs`: the audit's withdrawal decision
 * must be based on the publication endpoint, not on a version 404.
 *
 * A `wait_for_publication` timeout upstream leaves the server-side attempt
 * running, so "version does not resolve" is not proof that the throwaway audit
 * version never went public. Every unknown or malformed answer has to fail
 * closed, and a pending attempt has to fail the run rather than be treated as
 * absent.
 *
 * Each case runs the real script against a local HTTP server that mimics the two
 * documented endpoints, so the exit code, the captured stdout word and the
 * evidence file are all asserted end to end.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(__dirname, "../..");
const stateScript = resolve(repoRoot, "scripts/clawhub-publication-state.mjs");

interface RouteResult {
    status: number;
    body?: unknown;
}

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
    }
});

/** Serves the publication endpoint below `/publication` and the version endpoint above it. */
const startServer = async (resolveRoute: (url: string) => RouteResult | undefined) => {
    const server = createServer((request, response) => {
        const route = resolveRoute(request.url ?? "");
        if (!route) {
            response.writeHead(500).end();
            return;
        }
        response.writeHead(route.status, { "content-type": "application/json" });
        response.end(route.body === undefined ? "" : JSON.stringify(route.body));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
};

const runScript = async (site: string, env: Record<string, string> = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), "clawhub-publication-"));
    tempDirs.push(cwd);
    // `execFile`, not `spawnSync`: the fake server lives in this process, so
    // blocking the event loop here would deadlock the child.
    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
        const result = await execFileAsync(process.execPath, [stateScript], {
            cwd,
            encoding: "utf8",
            timeout: 20_000,
            env: {
                ...process.env,
                CLAWHUB_SITE: site,
                PACKAGE_NAME: "@soimy/dingtalk",
                BETA_VERSION: "3.9.0-beta.1.1",
                PUBLICATION_POLL_SECONDS: "0.05",
                PUBLICATION_TIMEOUT_SECONDS: "2",
                ...env,
            },
        });
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        status = typeof failure.code === "number" ? failure.code : 1;
        stdout = failure.stdout ?? "";
        stderr = failure.stderr ?? "";
    }
    const evidencePath = join(cwd, "publication-state.json");
    return {
        status,
        stdout: stdout.trim(),
        stderr,
        evidence: existsSync(evidencePath)
            ? (JSON.parse(readFileSync(evidencePath, "utf8")) as {
                  state: string;
                  settled: boolean;
                  samples: { state: string; source: string; attemptId: string | null }[];
              })
            : null,
    };
};

describe("clawhub publication state", () => {
    it("reports a published version from the publication endpoint", async () => {
        const site = await startServer(() => ({
            status: 200,
            body: { name: "@soimy/dingtalk", version: "3.9.0-beta.1.1", state: "published" },
        }));

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("published");
        expect(result.evidence?.state).toBe("published");
        expect(result.evidence?.samples[0]?.source).toBe("publication");
    });

    it("treats an absent version as nothing to withdraw", async () => {
        const site = await startServer(() => ({
            status: 200,
            body: { name: "@soimy/dingtalk", version: "3.9.0-beta.1.1", state: "absent" },
        }));

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("absent");
    });

    it("keeps the attempt id of a failed publication for the evidence bundle", async () => {
        const site = await startServer(() => ({
            status: 200,
            body: {
                name: "@soimy/dingtalk",
                version: "3.9.0-beta.1.1",
                state: "failed",
                attemptId: "attempt-42",
                recoverable: true,
            },
        }));

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("failed");
        expect(result.evidence?.samples.at(-1)?.attemptId).toBe("attempt-42");
    });

    it("waits out a pending attempt and reports where it settled", async () => {
        let calls = 0;
        const site = await startServer(() => {
            calls += 1;
            return {
                status: 200,
                body: {
                    name: "@soimy/dingtalk",
                    version: "3.9.0-beta.1.1",
                    state: calls === 1 ? "pending" : "published",
                    stage: calls === 1 ? "finalization" : undefined,
                    attemptId: "attempt-7",
                },
            };
        });

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("published");
        expect(result.evidence?.samples).toHaveLength(2);
        expect(result.evidence?.samples[0]?.state).toBe("pending");
    });

    it("fails the run instead of assuming an absent version when pending never settles", async () => {
        const site = await startServer(() => ({
            status: 200,
            body: {
                name: "@soimy/dingtalk",
                version: "3.9.0-beta.1.1",
                state: "pending",
                stage: "checks",
                attemptId: "attempt-99",
            },
        }));

        const result = await runScript(site, { PUBLICATION_TIMEOUT_SECONDS: "0.3" });

        expect(result.status).toBe(1);
        // Fail-closed, and actionable: the operator gets the exact cleanup command.
        expect(result.stderr).toContain("仍未进入终态");
        expect(result.stderr).toContain("attempt-99");
        expect(result.stderr).toContain("clawhub package delete @soimy/dingtalk --version 3.9.0-beta.1.1");
        expect(result.evidence?.state).toBe("pending");
        expect(result.evidence?.settled).toBe(false);
    });

    it("fails closed on a state it does not recognise", async () => {
        const site = await startServer(() => ({
            status: 200,
            body: { name: "@soimy/dingtalk", version: "3.9.0-beta.1.1", state: "quarantined-ish" },
        }));

        const result = await runScript(site, { PUBLICATION_TIMEOUT_SECONDS: "0.3" });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("未知状态");
    });

    it("falls back to the version endpoint when an older server answers without a state", async () => {
        const site = await startServer((url) =>
            url.endsWith("/publication")
                ? { status: 404 }
                : { status: 200, body: { name: "@soimy/dingtalk", version: "3.9.0-beta.1.1" } },
        );

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("published");
        expect(result.evidence?.samples[0]?.source).toBe("version-fallback");
    });

    it("does not read a 404 on both endpoints as published", async () => {
        const site = await startServer(() => ({ status: 404 }));

        const result = await runScript(site);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("absent");
    });

    it("keeps retrying a transient endpoint error and then fails closed", async () => {
        const site = await startServer(() => ({ status: 503 }));

        const result = await runScript(site, { PUBLICATION_TIMEOUT_SECONDS: "0.3" });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("publication 端点返回 HTTP 503");
    });
});
