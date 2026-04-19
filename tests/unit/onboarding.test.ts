import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";

vi.mock("openclaw/plugin-sdk/setup", () => ({
    DEFAULT_ACCOUNT_ID: "default",
    normalizeAccountId: (value: string) => value.trim() || "default",
    formatDocsLink: (path: string) => `https://docs.example${path}`,
}));

const mockBeginDeviceRegistration = vi.fn();
const mockOpenUrlInBrowser = vi.fn();

vi.mock("../../src/device-registration", () => ({
  beginDeviceRegistration: (...args: unknown[]) => mockBeginDeviceRegistration(...args),
  openUrlInBrowser: (...args: unknown[]) => mockOpenUrlInBrowser(...args),
  RegistrationError: class RegistrationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RegistrationError";
    }
  },
}));

import { dingtalkSetupAdapter, dingtalkSetupWizard } from "../../src/onboarding";

function listAccountIds(cfg: OpenClawConfig): string[] {
    const dingtalk = cfg.channels?.dingtalk as { accounts?: Record<string, unknown> } | undefined;
    return Object.keys(dingtalk?.accounts ?? {});
}

async function runSetupWizardConfigure(params: {
    cfg?: OpenClawConfig;
    prompter: WizardPrompter;
    shouldPromptAccountIds?: boolean;
}): Promise<{ cfg: OpenClawConfig; accountId: string }> {
    const cfg = (params.cfg ?? {}) as OpenClawConfig;
    const accountId =
        (await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
            cfg,
            prompter: params.prompter,
            shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
            listAccountIds,
            defaultAccountId: "default",
        })) ?? "default";

    const finalized = await dingtalkSetupWizard.finalize?.({
        cfg,
        accountId,
        prompter: params.prompter,
    });

    return {
        cfg: finalized?.cfg ?? cfg,
        accountId,
    };
}

describe("dingtalk setup wizard", () => {
    it("status returns configured=false for empty config", async () => {
        const configured = await dingtalkSetupWizard.status.resolveConfigured({ cfg: {} as any });

        expect(configured).toBe(false);
    });

    it("prompts to select an existing account when default account is missing", async () => {
        const confirm = vi.fn().mockResolvedValueOnce(true);
        const select = vi.fn().mockResolvedValueOnce("acct-b");
        const text = vi.fn();

        const accountId = await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
            cfg: {
                channels: {
                    dingtalk: {
                        accounts: {
                            "acct-a": { clientId: "id-a", clientSecret: "sec-a" },
                            "acct-b": { clientId: "id-b", clientSecret: "sec-b" },
                        },
                    },
                },
            } as any,
            prompter: { confirm, select, text } as unknown as WizardPrompter,
            shouldPromptAccountIds: true,
            listAccountIds: () => ["acct-a", "acct-b"],
            defaultAccountId: "default",
        });

        expect(accountId).toBe("acct-b");
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledTimes(1);
        expect(text).not.toHaveBeenCalled();
    });

    it("configure writes card + allowlist settings", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce('ding_client')       // clientId
            .mockResolvedValueOnce('ding_secret')        // clientSecret
            .mockResolvedValueOnce('user_a, user_b')     // allowFrom (dmPolicy=allowlist)
            .mockResolvedValueOnce('')                   // mediaUrlAllowlist
            .mockResolvedValueOnce('grp_user1, grp_user2') // groupAllowFrom
            .mockResolvedValueOnce('7')                  // maxReconnectCycles
            .mockResolvedValueOnce('20')                 // mediaMaxMb
            .mockResolvedValueOnce('14');                // journalTTLDays

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")     // credential method
            .mockResolvedValueOnce("answer")     // cardStreamingMode
            .mockResolvedValueOnce("allowlist")  // dmPolicy
            .mockResolvedValueOnce("allowlist")  // groupPolicy
            .mockResolvedValueOnce("all");       // displayNameResolution

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error("Expected dingtalk config to be present");
        }

        expect(result.accountId).toBe("default");
        expect(dingtalkConfig.clientId).toBe("ding_client");
        expect(dingtalkConfig.clientSecret).toBe("ding_secret");
        expect((dingtalkConfig as any).corpId).toBeUndefined();
        expect((dingtalkConfig as any).agentId).toBeUndefined();
        expect(dingtalkConfig.messageType).toBe("card");
        expect(dingtalkConfig.cardStreamingMode).toBe("answer");
        expect(dingtalkConfig.cardTemplateId).toBeUndefined();
        expect(dingtalkConfig.cardTemplateKey).toBeUndefined();
        expect(dingtalkConfig.allowFrom).toEqual(["user_a", "user_b"]);
        expect(dingtalkConfig.groupAllowFrom).toEqual(["grp_user1", "grp_user2"]);
        expect(dingtalkConfig.displayNameResolution).toBe("all");
        expect(dingtalkConfig.mediaUrlAllowlist).toBeUndefined();
        expect(dingtalkConfig.maxReconnectCycles).toBe(7);
        expect(dingtalkConfig.mediaMaxMb).toBe(20);
        expect(dingtalkConfig.journalTTLDays).toBe(14);
        expect(note).toHaveBeenCalled();
        expect(note).toHaveBeenCalledWith(
            expect.stringContaining('built-in DingTalk template contract'),
            'Built-in AI Card Template',
        );
    });

    it("generic setup input stores clientId and clientSecret without legacy fields", () => {
        const cfg = dingtalkSetupAdapter.applyAccountConfig({
            cfg: {} as any,
            accountId: "default",
            input: {
                token: "ding_client",
                password: "ding_secret",
                code: "ding_robot",
            } as any,
        });

        const dingtalkConfig = cfg.channels?.dingtalk;
        expect(dingtalkConfig?.clientId).toBe("ding_client");
        expect(dingtalkConfig?.clientSecret).toBe("ding_secret");
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
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")     // credential method
            .mockResolvedValueOnce("open")       // dmPolicy
            .mockResolvedValueOnce("disabled")   // groupPolicy
            .mockResolvedValueOnce("disabled");  // displayNameResolution

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
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

    it("auto-register branch writes credentials to config", async () => {
        mockBeginDeviceRegistration.mockResolvedValueOnce({
            verificationUrl: "https://oapi.dingtalk.com/verify?code=test",
            waitForResult: vi.fn().mockResolvedValueOnce({
                clientId: "ding-auto-id",
                clientSecret: "ding-auto-secret-12345",
            }),
        });

        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("")       // mediaUrlAllowlist
            .mockResolvedValueOnce("")       // groupAllowFrom
            .mockResolvedValueOnce("7")      // maxReconnectCycles
            .mockResolvedValueOnce("20")     // mediaMaxMb
            .mockResolvedValueOnce("14");    // journalTTLDays

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(false)    // card mode
            .mockResolvedValueOnce(true)     // reconnect limits
            .mockResolvedValueOnce(true)     // mediaMaxMb
            .mockResolvedValueOnce(true);    // journalTTLDays

        const select = vi
            .fn()
            .mockResolvedValueOnce("auto")       // credential method
            .mockResolvedValueOnce("open")       // dmPolicy
            .mockResolvedValueOnce("open")       // groupPolicy
            .mockResolvedValueOnce("disabled");  // displayNameResolution

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-auto-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-auto-secret-12345");
        expect(mockOpenUrlInBrowser).toHaveBeenCalledWith(
            "https://oapi.dingtalk.com/verify?code=test",
        );
    });

    it("auto-register failure falls back to manual input", async () => {
        mockBeginDeviceRegistration.mockRejectedValueOnce(
            new (class extends Error {
              name = "RegistrationError";
              constructor() { super("network timeout"); }
            })(),
        );

        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-fallback-id")    // clientId (manual)
            .mockResolvedValueOnce("ding-fallback-secret") // clientSecret (manual)
            .mockResolvedValueOnce("")       // mediaUrlAllowlist
            .mockResolvedValueOnce("")       // groupAllowFrom
            .mockResolvedValueOnce("10")     // maxReconnectCycles
            .mockResolvedValueOnce("20")     // mediaMaxMb
            .mockResolvedValueOnce("7");     // journalTTLDays

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(false)    // card mode
            .mockResolvedValueOnce(true)     // reconnect limits
            .mockResolvedValueOnce(true)     // mediaMaxMb
            .mockResolvedValueOnce(true);    // journalTTLDays

        const select = vi
            .fn()
            .mockResolvedValueOnce("auto")       // credential method (chooses auto but it fails)
            .mockResolvedValueOnce("open")       // dmPolicy
            .mockResolvedValueOnce("open")       // groupPolicy
            .mockResolvedValueOnce("disabled");  // displayNameResolution

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-fallback-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-fallback-secret");
        expect(note).toHaveBeenCalledWith(expect.stringContaining("network timeout"), expect.any(String));
    });

    it("manual branch works unchanged", async () => {
        mockBeginDeviceRegistration.mockReset();

        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-manual-id")
            .mockResolvedValueOnce("ding-manual-secret")
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("")
            .mockResolvedValueOnce("10")
            .mockResolvedValueOnce("20")
            .mockResolvedValueOnce("7");

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")     // credential method
            .mockResolvedValueOnce("open")       // dmPolicy
            .mockResolvedValueOnce("open")       // groupPolicy
            .mockResolvedValueOnce("disabled");  // displayNameResolution

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-manual-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-manual-secret");
        expect(mockBeginDeviceRegistration).not.toHaveBeenCalled();
    });
});
