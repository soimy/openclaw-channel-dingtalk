/**
 * Covers the ClawHub security audit verdict policy
 * (`scripts/clawhub-beta-gate.mjs`).
 *
 * The verdict is the only reading of a ClawScan result an operator gets, so its
 * failure modes matter more than its happy path: every unknown, missing, or
 * unfinished trust input must fail closed, and `suspicious` must only pass when
 * the operator explicitly opted in.
 *
 * The audit is informational and no longer gates publishing, so the workflow
 * wiring tests below also pin that separation: the publish workflow must not
 * depend on the audit, and the audit workflow must be dispatch-only and clean up
 * the throwaway version it publishes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const gateScript = resolve(repoRoot, "scripts/clawhub-beta-gate.mjs");
const publishWorkflowPath = resolve(repoRoot, ".github/workflows/clawhub-publish.yml");
const auditWorkflowPath = resolve(repoRoot, ".github/workflows/clawhub-audit.yml");

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createWorkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "clawhub-beta-gate-"));
    tempDirs.push(dir);
    return dir;
}

function buildVerdict(trust: Record<string, unknown> | null): Record<string, unknown> {
    return {
        overview: "ClawScan found no material security concerns.",
        securityAuditUrl: "https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=1.2.3",
        package: { name: "@soimy/dingtalk", displayName: "DingTalk", family: "code-plugin" },
        release: { releaseId: "release-1", version: "1.2.3" },
        trust:
            trust === null
                ? null
                : {
                      scanStatus: "clean",
                      moderationState: null,
                      blockedFromDownload: false,
                      reasons: [],
                      pending: false,
                      stale: false,
                      ...trust,
                  },
    };
}

function runGate(options: {
    verdict?: unknown;
    raw?: string;
    env?: Record<string, string>;
    withFile?: boolean;
}): { status: number; stdout: string; stderr: string; result: Record<string, unknown> | null } {
    const dir = createWorkDir();
    const withFile = options.withFile ?? true;

    if (withFile) {
        const raw = options.raw ?? JSON.stringify(options.verdict ?? buildVerdict({}));
        writeFileSync(join(dir, "verdict.json"), raw, "utf8");
    }

    const exec = spawnSync(process.execPath, [gateScript, "verdict.json"], {
        cwd: dir,
        encoding: "utf8",
        env: {
            ...process.env,
            PACKAGE_NAME: "@soimy/dingtalk",
            BETA_VERSION: "1.2.3-beta.7.1",
            AUDIT_VERSION_RETENTION: "withdrawn",
            ALLOW_SUSPICIOUS: "",
            GITHUB_STEP_SUMMARY: "",
            ...options.env,
        },
    });

    const resultPath = join(dir, "gate-result.json");
    return {
        status: exec.status ?? -1,
        stdout: exec.stdout,
        stderr: exec.stderr,
        result: existsSync(resultPath)
            ? (JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>)
            : null,
    };
}

describe("clawhub beta gate policy", () => {
    it("passes a clean verdict", () => {
        const run = runGate({ verdict: buildVerdict({}) });

        expect(run.status).toBe(0);
        expect(run.result?.decision).toBe("pass");
        expect(run.result?.hardFailures).toEqual([]);
    });

    it("blocks suspicious by default and names the override", () => {
        const run = runGate({ verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }) });

        expect(run.status).toBe(1);
        expect(run.result?.decision).toBe("fail");
        expect(String((run.result?.hardFailures as string[])[0])).toContain("ALLOW_SUSPICIOUS");
    });

    it("passes suspicious only with the explicit override", () => {
        const run = runGate({
            verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }),
            env: { ALLOW_SUSPICIOUS: "1" },
        });

        expect(run.status).toBe(0);
        expect(run.result?.decision).toBe("pass-with-override");
        expect(run.result?.warnings).toHaveLength(1);
    });

    it.each([
        ["malicious scan status", { scanStatus: "malicious" }],
        ["not-run scan status", { scanStatus: "not-run" }],
        ["pending scan status", { scanStatus: "pending" }],
        ["download block", { blockedFromDownload: true }],
        ["unfinished trust inputs", { pending: true }],
        ["stale trust summary", { stale: true }],
        ["quarantined release", { moderationState: "quarantined" }],
        ["revoked release", { moderationState: "revoked" }],
        ["unknown scan status", { scanStatus: "something-new" }],
        ["string download block", { blockedFromDownload: "true" }],
        ["numeric pending flag", { pending: 1 }],
        ["string stale flag", { stale: "false" }],
        ["non-string moderation state", { moderationState: 42 }],
    ])("fails closed on %s", (_label, trust) => {
        const run = runGate({ verdict: buildVerdict(trust) });

        expect(run.status).toBe(1);
        expect(run.result?.decision).toBe("fail");
        expect((run.result?.hardFailures as string[]).length).toBeGreaterThan(0);
    });

    it.each([
        ["a missing download-block flag", "blockedFromDownload"],
        ["a missing pending flag", "pending"],
        ["a missing stale flag", "stale"],
        ["a missing moderation state", "moderationState"],
        ["a missing reasons list", "reasons"],
    ])("fails closed when the verdict has %s", (_label, key) => {
        const trust = buildVerdict({}).trust as Record<string, unknown>;
        delete trust[key];

        const run = runGate({ verdict: { ...buildVerdict({}), trust } });

        expect(run.status).toBe(1);
        expect(run.result?.decision).toBe("fail");
        expect((run.result?.hardFailures as string[]).join(" ")).toContain(key);
    });

    it("fails closed when the response has no trust object", () => {
        const run = runGate({ verdict: buildVerdict(null) });

        expect(run.status).toBe(1);
        expect(String((run.result?.hardFailures as string[])[0])).toContain("trust");
    });

    it("fails closed on malformed JSON", () => {
        const run = runGate({ raw: "{ not json" });

        expect(run.status).toBe(1);
        expect(String((run.result?.hardFailures as string[])[0])).toContain("JSON");
    });

    it("fails closed when the verdict file is missing", () => {
        const run = runGate({ withFile: false });

        expect(run.status).toBe(1);
        expect(run.result?.ok).toBe(false);
    });

    it("records the trust evidence for the CI artifact", () => {
        const run = runGate({
            verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }),
            env: { ALLOW_SUSPICIOUS: "1", AUDIT_VERSION_RETENTION: "kept" },
        });

        expect(run.result).toMatchObject({
            ok: true,
            packageName: "@soimy/dingtalk",
            betaVersion: "1.2.3-beta.7.1",
            versionRetention: "kept",
            allowSuspicious: true,
            scanStatus: "suspicious",
            reasons: ["scan:suspicious"],
            securityAuditUrl: "https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=1.2.3",
        });
    });

    it("reports the audit version disposition without letting it steer the decision", () => {
        const withdrawn = runGate({ verdict: buildVerdict({}) });
        const kept = runGate({ verdict: buildVerdict({}), env: { AUDIT_VERSION_RETENTION: "kept" } });

        expect(withdrawn.result?.versionRetention).toBe("withdrawn");
        expect(kept.result?.versionRetention).toBe("kept");
        expect(withdrawn.result?.decision).toBe("pass");
        expect(kept.result?.decision).toBe("pass");
    });

    it("defaults to reporting a withdrawn audit version when the flag is unset", () => {
        const run = runGate({ verdict: buildVerdict({}), env: { AUDIT_VERSION_RETENTION: "" } });

        expect(run.result?.versionRetention).toBe("withdrawn");
    });

    it("prints the ClawScan overview for the operator", () => {
        const run = runGate({ verdict: buildVerdict({}) });

        expect(run.stdout).toContain("ClawScan found no material security concerns.");
    });
});

/** The `on:` block, so trigger assertions cannot be satisfied by a step body. */
function triggerBlock(workflow: string): string {
    const start = workflow.indexOf("\non:");
    expect(start).toBeGreaterThan(-1);
    const end = workflow.indexOf("\njobs:");
    expect(end).toBeGreaterThan(start);
    return workflow.slice(start, end);
}

describe("clawhub publish workflow wiring", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8");

    it("no longer gates publishing on a ClawHub audit", () => {
        // The audit is manual now: publishing must not depend on it, and no audit
        // state may leak into the release path.
        expect(workflow).not.toContain("needs: audit");
        expect(workflow).not.toContain("audit_only");
        expect(workflow).not.toContain("allow_suspicious");
        expect(workflow).not.toContain("audited_commit");
        expect(workflow).not.toContain("clawhub-beta-gate");
        expect(workflow).not.toContain("--tags audit");
        expect(workflow).not.toContain("clawhub package delete");
    });

    it("still triggers on tags and on an explicit dispatch with a tag", () => {
        const triggers = triggerBlock(workflow);

        expect(triggers).toContain("workflow_dispatch:");
        expect(triggers).toContain("push:");
        expect(triggers).toContain('description: Existing git tag to publish');
    });

    it("publishes the resolved tag commit rather than whatever the checkout holds", () => {
        expect(workflow).toContain('git fetch --force origin "refs/tags/${TAG}:refs/tags/${TAG}"');
        expect(workflow).toContain('git rev-parse "refs/tags/${TAG}^{commit}"');
        // Source attribution now travels as an input: the publish itself runs
        // upstream, so there is no local `--source-commit` flag left to assert.
        expect(workflow).toContain("source_commit: ${{ needs.verify.outputs.release_commit }}");
    });

    it("keeps the version sync check and the release dist-tags", () => {
        expect(workflow).toContain('RAW_VERSION="${TAG#v}"');
        expect(workflow).toContain('CLAWHUB_TAG="latest"');
        expect(workflow).toContain('CLAWHUB_TAG="beta"');
    });

    it("hands a prebuilt tarball to the reusable publisher", () => {
        // Packing here is what keeps the upstream runner from having to install
        // pnpm and rebuild this project; the artifact path travels as an output
        // because the tarball is not renamed.
        expect(workflow).toContain("openclaw/clawhub/.github/workflows/package-publish.yml@");
        expect(workflow).toContain("package_artifact_name: clawhub-clawpack");
        expect(workflow).toContain("package_artifact_path: ${{ needs.verify.outputs.tarball_name }}");
        expect(workflow).toContain('echo "tarball_name=$(basename "${TARBALL}")" >> "$GITHUB_OUTPUT"');
    });

    it("publishes for real and waits for a terminal publication state", () => {
        // `dry_run` defaults to true upstream: leaving it out would turn the
        // release into a green preview.
        expect(workflow).toContain("dry_run: false");
        // ClawHub accepts a publish as `pending-publication`, so without the wait
        // the run reports success while the version still resolves to 404.
        expect(workflow).toContain("wait_for_publication: true");

        const publicationTimeout = Number(
            /publication_timeout_minutes:\s*(\d+)/.exec(workflow)?.[1] ?? 0,
        );
        expect(publicationTimeout).toBeGreaterThan(0);
        // The reusable workflow rejects anything above 40.
        expect(publicationTimeout).toBeLessThanOrEqual(40);
    });

    it("pins the reusable workflow to a reviewed commit and installs no local CLI", () => {
        // The upstream job executes with this repository's CLAWHUB_TOKEN, so a
        // branch reference would let an unreviewed commit run next to the secret.
        const uses = /uses: openclaw\/clawhub\/\.github\/workflows\/package-publish\.yml@(\S+)/.exec(
            workflow,
        );
        expect(uses).not.toBeNull();
        expect(uses?.[1]).toMatch(/^[0-9a-f]{40}$/);

        // Publishing through the pinned CLI is exactly what stopped working: the
        // npm dist-tag lags the protocol and does not read `Retry-After`.
        expect(workflow).not.toContain("run: npm install");
        expect(workflow).not.toContain("clawhub@0.23.3");
    });
});

describe("clawhub audit workflow wiring", () => {
    const workflow = readFileSync(auditWorkflowPath, "utf8");

    it("is manual-only", () => {
        const triggers = triggerBlock(workflow);

        expect(triggers).toContain("workflow_dispatch:");
        expect(triggers).not.toContain("push:");
    });

    it("exposes the override and the retention switch as dispatch inputs", () => {
        const triggers = triggerBlock(workflow);

        expect(triggers).toContain("allow_suspicious:");
        expect(triggers).toContain("keep_audit_version:");
    });

    it("publishes the audit build on a dedicated tag and waits for the verdict", () => {
        expect(workflow).toContain("tags: audit");
        expect(workflow).toContain("dry_run: false");
        expect(workflow).toContain("wait_for_publication: true");
    });

    it("keeps the publish step on the same pinned reusable workflow as a release", () => {
        // Both paths share one publish implementation on purpose: the audit used
        // to fail exactly where the release did, for the same client-version
        // reason.
        const uses = /uses: openclaw\/clawhub\/\.github\/workflows\/package-publish\.yml@(\S+)/.exec(
            workflow,
        );
        expect(uses).not.toBeNull();
        expect(uses?.[1]).toMatch(/^[0-9a-f]{40}$/);
        expect(workflow).toContain("package_artifact_name: clawhub-audit-clawpack");
    });

    it("uses the public version-exact security endpoint as the verdict input", () => {
        expect(workflow).toContain("/versions/${AUDIT_VERSION}/security");
        expect(workflow).toContain("scripts/clawhub-beta-gate.mjs verdict.json");
    });

    it("keeps a CLI version that supports restorable withdrawal", () => {
        expect(workflow).not.toContain("clawhub@0.23.1");
        expect(workflow).toContain("clawhub@0.23.3");
        expect(workflow).toContain("clawhub package delete");
    });

    it("withdraws the audit version by default and verifies it is gone", () => {
        expect(workflow).toContain("Withdraw the audit build");
        expect(workflow).toContain("if: ${{ always() && !inputs.keep_audit_version }}");
        // The post-condition is asserted, not assumed: a withdrawal that left the
        // version resolvable must fail the run.
        expect(workflow).toContain('if [[ "${STATUS_AFTER}" != "404" ]]');
    });

    it("still renders a verdict and withdraws when the publish job fails", () => {
        // The publish is a separate job now, so its failure must not take the
        // verdict, the report and the cleanup down with it.
        expect(workflow).toContain("needs: [prepare, publish]");
        expect(workflow).toContain("if: ${{ always() }}");
    });

    it("keeps the retained-version path visible when the switch is on", () => {
        expect(workflow).toContain("openclaw plugins install clawhub:${AUDIT_PACKAGE}@${AUDIT_VERSION}");
        expect(workflow).toContain("clean up later");
    });

    it("reports the disposition the gate script was told about", () => {
        expect(workflow).toContain(
            "AUDIT_VERSION_RETENTION: ${{ inputs.keep_audit_version && 'kept' || 'withdrawn' }}",
        );
        expect(workflow).toContain("ALLOW_SUSPICIOUS: ${{ inputs.allow_suspicious && '1' || '0' }}");
    });

    it("keeps third-party execution out of the credentialed window", () => {
        // A pinned CLI and never a mutable `@latest` reference, with the offline
        // validation running before the publish token is loaded.
        expect(workflow).not.toContain("plugin-inspector@latest");
        expect(workflow).toContain("clawhub package validate .");
        expect(workflow.indexOf("Offline plugin validation")).toBeLessThan(
            workflow.indexOf("Authenticate ClawHub CLI"),
        );
    });

    it("archives the verdict evidence even when the audit fails", () => {
        expect(workflow).toContain("Upload the audit evidence");
        expect(workflow).toContain("if: ${{ always() }}");
        for (const file of ["verdict.json", "gate-result.json", "publish-result/**", "scan-report.zip"]) {
            expect(workflow).toContain(file);
        }
    });
});
