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
        // The resolved commit, not the checkout, is what gets attributed.
        expect(workflow).toContain('--source-commit "${RELEASE_COMMIT}"');
    });

    it("keeps the version sync check and the release dist-tags", () => {
        expect(workflow).toContain('RAW_VERSION="${TAG#v}"');
        expect(workflow).toContain('CLAWHUB_TAG="latest"');
        expect(workflow).toContain('CLAWHUB_TAG="beta"');
    });

    it("packs the tarball once and hands it to the publish job", () => {
        // Packing here keeps the publish job from installing pnpm and rebuilding;
        // the name travels as an output because the tarball is not renamed.
        expect(workflow).toContain("name: clawhub-clawpack");
        expect(workflow).toContain('echo "tarball_name=$(basename "${TARBALL}")" >> "$GITHUB_OUTPUT"');
        expect(workflow).toContain('"${RUNNER_TEMP}/clawpack/${TARBALL_NAME}"');
    });

    it("publishes for real and waits for a terminal publication state", () => {
        // ClawHub accepts a publish as `pending-publication`, so without the wait
        // the run reports success while the version still resolves to 404.
        expect(workflow).toContain("--wait");
        expect(workflow).toContain("--wait-timeout 2400");
        // The wait is the contract, but the terminal status it produces is still
        // asserted: a CLI that drops the wait must fail here, not ship green.
        expect(workflow).toContain("publicationStatus !== 'published'");

        // A job timeout at or below the wait timeout would kill the wait before
        // the CLI could report a terminal state.
        const publishJob = workflow.slice(workflow.indexOf("\n    publish:"));
        expect(publishJob.length).toBeGreaterThan(0);
        const waitTimeoutSeconds = Number(/--wait-timeout (\d+)/.exec(publishJob)?.[1] ?? 0);
        const jobTimeoutMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(publishJob)?.[1] ?? 0);
        expect(waitTimeoutSeconds).toBeGreaterThan(0);
        expect(jobTimeoutMinutes * 60).toBeGreaterThan(waitTimeoutSeconds);
    });

    it("runs the pinned ClawHub CLI from source instead of the npm dist-tag", () => {
        // The npm dist-tag lags the publish protocol (staged uploads, settling).
        expect(workflow).not.toContain("run: npm install");
        expect(workflow).not.toContain("clawhub@0.23.3");

        // This code runs with CLAWHUB_TOKEN, so it is pinned to a reviewed commit
        // rather than a branch.
        expect(workflow).toContain("repository: openclaw/clawhub");
        const ref = /repository: openclaw\/clawhub\n\s+ref: (\S+)/.exec(workflow);
        expect(ref).not.toBeNull();
        expect(ref?.[1]).toMatch(/^[0-9a-f]{40}$/);
        expect(workflow).toContain("packages/clawhub/src/cli.ts");
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
        // The throwaway build must never land on `latest` or `beta`.
        expect(workflow).toContain("--tags audit");
        expect(workflow).toContain("--wait");
        expect(workflow).toContain("--wait-timeout 2400");
    });

    it("runs the same pinned ClawHub CLI source as a release", () => {
        // Both paths share one publish implementation on purpose: the audit used
        // to fail exactly where the release did, for the same client-version
        // reason. The wiring test below asserts the two refs are identical.
        expect(workflow).toContain("repository: openclaw/clawhub");
        expect(workflow).toContain("name: clawhub-audit-clawpack");
        expect(workflow).toContain("packages/clawhub/src/cli.ts");
        expect(workflow).not.toContain("uses: openclaw/clawhub/.github/workflows/package-publish.yml");
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

    it("settles the publication state before deciding whether to withdraw", () => {
        // A `wait_for_publication` timeout leaves the server-side attempt running:
        // the version endpoint can still answer 404 while the release goes public
        // later, so the decision has to come from the publication endpoint.
        expect(workflow).toContain("node scripts/clawhub-publication-state.mjs");
        // The version comes from another job now, so the guard reads `needs`
        // instead of `steps`: a failed `prepare` must not wait on an empty version.
        // `always()` is what makes the settle step run after a failed verdict:
        // a bare `if:` implies `success()`, which is the case that must not skip.
        expect(workflow).toContain(
            "if: ${{ always() && needs.prepare.outputs.audit_version != '' && !inputs.keep_audit_version }}",
        );
        // Withdrawal runs for anything that is not settled-absent/failed, so a
        // failed probe cannot skip cleanup; its post-condition is the installable
        // surface, and a version that still resolves fails the run.
        expect(workflow).toContain("steps.publication.outputs.state != 'absent'");
        expect(workflow).toContain("steps.publication.outputs.state != 'failed'");
        expect(workflow).toContain('if [[ "${STATUS_AFTER}" != "404" ]]');
        // A 404 only counts as "nothing to withdraw" when the probe settled; a
        // pending attempt that has not surfaced yet must fail loudly instead.
        expect(workflow).toContain('require("./publication-state.json")');
        expect(workflow).toContain("s.settled === false");
    });

    it("runs the audit tooling at a fixed revision, not at the audited tree", () => {
        // `github.workflow_sha` is fixed for the run, so a moving branch still
        // cannot swap the gate script. The audited commit is the wrong checkout:
        // run 39527450201 audited a branch that predated
        // `scripts/clawhub-publication-state.mjs`, the settle step crashed with
        // MODULE_NOT_FOUND, and the throwaway version was left published.
        expect(workflow).toContain("ref: ${{ github.workflow_sha || github.sha }}");
        expect(workflow).not.toContain("needs.prepare.outputs.audited_commit ||");
    });

    it("keeps collecting evidence when the verdict fails", () => {
        // `continue-on-error` only covers the step's own failure, so a non-clean
        // verdict would otherwise skip both collectors and leave half the bundle.
        const blockOf = (name: string) => {
            const start = workflow.indexOf(`- name: ${name}`);
            expect(start).toBeGreaterThan(-1);
            const next = workflow.indexOf("- name: ", start + 1);
            return workflow.slice(start, next === -1 ? undefined : next);
        };
        for (const name of ["Download the ClawHub audit report", "Collect the publish result"]) {
            expect(blockOf(name)).toContain("if: ${{ always() }}");
        }
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

    it("offers a cleanup-only mode that withdraws without publishing", () => {
        // `CLAWHUB_TOKEN` only exists in CI, so a leftover audit version has to be
        // removable from here rather than from a local CLI install.
        expect(workflow).toContain("withdraw_version:");
        expect(workflow).toContain("if: ${{ inputs.withdraw_version != '' }}");
        // A cleanup run must not audit: both the build and the verdict are skipped.
        expect(workflow).toContain("if: ${{ inputs.withdraw_version == '' }}");
        expect(workflow).toContain("if: ${{ inputs.withdraw_version == '' && always() }}");

        const withdrawJob = workflow.slice(workflow.indexOf("\n    withdraw:"));
        expect(withdrawJob).toContain("clawhub package delete");
        expect(withdrawJob).not.toContain("package publish");
        // Same post-condition as the audit path: gone means a 404.
        expect(withdrawJob).toContain('if [[ "${STATUS_AFTER}" != "404" ]]');
    });

    it("archives the verdict evidence even when the audit fails", () => {
        expect(workflow).toContain("Upload the audit evidence");
        expect(workflow).toContain("if: ${{ always() }}");
        for (const file of [
            "verdict.json",
            "gate-result.json",
            "publication-state.json",
            "publish-result/**",
            "scan-report.zip",
        ]) {
            expect(workflow).toContain(file);
        }
    });
});

describe("clawhub CLI pinning", () => {
    it("pins the release and the audit to the same upstream commit", () => {
        // Both paths run the same CLI source: bumping only one side would
        // reintroduce the drift that made the audit fail where a release worked.
        const refOf = (path: string) => {
            const match = /repository: openclaw\/clawhub\n\s+ref: (\S+)/.exec(
                readFileSync(path, "utf8"),
            );
            expect(match).not.toBeNull();
            return match?.[1];
        };

        expect(refOf(publishWorkflowPath)).toBe(refOf(auditWorkflowPath));
    });
});
