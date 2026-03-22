import { describe, expect, it, vi } from "vitest";
import {
    createSetupWizardAdapter,
    runSetupWizardConfigure,
    type WizardPrompter,
} from "../../../openclaw/test/helpers/extensions/setup-wizard";

vi.mock("openclaw/plugin-sdk/matrix", () => ({
    DEFAULT_ACCOUNT_ID: "default",
    normalizeAccountId: (value: string) => value.trim() || "default",
    formatDocsLink: (path: string) => `https://docs.example${path}`,
}));

import { dingtalkSetupAdapter, dingtalkSetupWizard } from "../../src/onboarding";

const configureDingTalk = createSetupWizardAdapter({
    plugin: {
        id: "dingtalk",
        meta: { label: "DingTalk" },
        config: {
            listAccountIds: () => [],
            defaultAccountId: () => "default",
        },
        setup: dingtalkSetupAdapter,
        setupWizard: dingtalkSetupWizard,
    } as any,
    wizard: dingtalkSetupWizard,
}).configure;

describe("dingtalk setup wizard", () => {
    it("status returns configured=false for empty config", async () => {
        const configured = await dingtalkSetupWizard.status.resolveConfigured({ cfg: {} as any });

        expect(configured).toBe(false);
    });

    it("configure writes card + allowlist settings", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding_client")
            .mockResolvedValueOnce("ding_secret")
            .mockResolvedValueOnce("ding_robot")
            .mockResolvedValueOnce("ding_corp")
            .mockResolvedValueOnce("12345")
            .mockResolvedValueOnce("tmpl.schema")
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("user_a, user_b")
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("grp_user1, grp_user2")
            .mockResolvedValueOnce("7")
            .mockResolvedValueOnce("20")
            .mockResolvedValueOnce("14");

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce("allowlist")
            .mockResolvedValueOnce("allowlist")
            .mockResolvedValueOnce("all");

        const result = await runSetupWizardConfigure({
            configure: configureDingTalk,
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
            options: {},
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error("Expected dingtalk config to be present");
        }

        expect(result.accountId).toBe("default");
        expect(dingtalkConfig.clientId).toBe("ding_client");
        expect(dingtalkConfig.clientSecret).toBe("ding_secret");
        expect(dingtalkConfig.robotCode).toBe("ding_robot");
        expect(dingtalkConfig.messageType).toBe("card");
        expect(dingtalkConfig.cardTemplateId).toBe("tmpl.schema");
        expect(dingtalkConfig.cardTemplateKey).toBe("content");
        expect(dingtalkConfig.allowFrom).toEqual(["user_a", "user_b"]);
        expect(dingtalkConfig.groupAllowFrom).toEqual(["grp_user1", "grp_user2"]);
        expect(dingtalkConfig.displayNameResolution).toBe("all");
        expect(dingtalkConfig.mediaUrlAllowlist).toBeUndefined();
        expect(dingtalkConfig.maxReconnectCycles).toBe(7);
        expect(dingtalkConfig.mediaMaxMb).toBe(20);
        expect(dingtalkConfig.journalTTLDays).toBe(14);
        expect(note).toHaveBeenCalled();
    });

    it("configure with disabled groupPolicy skips groupAllowFrom prompt", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding_client")
            .mockResolvedValueOnce("ding_secret")
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("7")
            .mockResolvedValueOnce("20")
            .mockResolvedValueOnce("14");

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("disabled")
            .mockResolvedValueOnce("disabled");

        const result = await runSetupWizardConfigure({
            configure: configureDingTalk,
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
            options: {},
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error("Expected dingtalk config to be present");
        }

        expect(dingtalkConfig.groupPolicy).toBe("disabled");
        expect(dingtalkConfig.groupAllowFrom).toBeUndefined();
        expect(text).toHaveBeenCalledTimes(6);
    });
});
