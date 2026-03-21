import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialManifest } from "../../../scripts/real-device-debug/session-contract.mjs";
import { loadScenario } from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";
import {
    buildScenarioEvidenceLog,
    collectScenarioEvidence,
} from "../../../scripts/real-device-scenarios/runtime/log-evidence.mjs";

describe("real-device-scenarios log evidence", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-device-log-evidence-"));
        tempDirs.push(dir);
        return dir;
    }

    it("collects scenario evidence lines from a gateway log using trace and expectation hints", () => {
        const outputRoot = createTempDir();
        const scenario = loadScenario("pr389-preview-store-miss");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: scenario.id,
            targetId: "manager8031",
            targetLabel: "Manual User",
            traceSuffix: "7F2A",
        });
        const gatewayLogPath = path.join(outputRoot, "gateway.log");
        fs.writeFileSync(
            gatewayLogPath,
            [
                "ignore this unrelated line",
                "2026-03-21T08:16:00.000Z info [dingtalk] handleDingTalkMessage",
                "2026-03-21T08:16:01.000Z info trace=DTDBG-20260321-081530-7F2A quotedRef hit=no previewText=PR389-PREVIEW-STOREMISS-SEED",
                "2026-03-21T08:16:02.000Z info [outbound] sendMessage ok replyPreview=PR389-PREVIEW-STOREMISS-SEED",
                "2026-03-21T08:16:03.000Z info [outbound] sendBySession ok",
            ].join("\n"),
            "utf8",
        );

        const collected = collectScenarioEvidence({
            gatewayLogPath,
            manifest,
            scenario,
        });

        expect(collected).toContain("quotedRef hit=no");
        expect(collected).toContain("PR389-PREVIEW-STOREMISS-SEED");
        expect(collected).toContain("sendBySession ok");
        expect(collected).not.toContain("ignore this unrelated line");
    });

    it("writes scenario evidence into filtered.log under the run session", () => {
        const outputRoot = createTempDir();
        const scenario = loadScenario("pr389-quoted-attachment");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: scenario.id,
            targetId: "manager8031",
            targetLabel: "Manual User",
            traceSuffix: "7F2A",
        });
        const gatewayLogPath = path.join(outputRoot, "gateway.log");
        fs.writeFileSync(
            gatewayLogPath,
            [
                "2026-03-21T08:16:00.000Z info fileName=pr389-quoted-attachment.txt",
                "2026-03-21T08:16:01.000Z info trace=DTDBG-20260321-081530-7F2A quotedRef hit=yes",
                "2026-03-21T08:16:02.000Z info [outbound] sendMessage ok replyPreview=PR389-ATTACHMENT-SEED",
            ].join("\n"),
            "utf8",
        );

        const filteredLogPath = buildScenarioEvidenceLog({
            gatewayLogPath,
            manifest,
            scenario,
        });
        const filtered = fs.readFileSync(filteredLogPath, "utf8");

        expect(filtered).toContain("pr389-quoted-attachment.txt");
        expect(filtered).toContain("PR389-ATTACHMENT-SEED");
    });
});
