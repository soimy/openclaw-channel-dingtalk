import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";

import { getConfig, resolveGatewayCapabilityConfig } from "../../src/platform/config";

const repoRoot = resolve(__dirname, "../..");

function readJsonFile<T>(relativePath: string): T {
    return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}

describe("plugin manifest channel metadata", () => {
    it("publishes DingTalk channel config metadata for the host WebUI", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    label?: string;
                    description?: string;
                    schema?: {
                        type?: string;
                        properties?: Record<string, unknown>;
                    };
                    uiHints?: Record<string, { label?: string; sensitive?: boolean }>;
                }
            >;
        }>("openclaw.plugin.json");

        expect(manifest.channelConfigs?.dingtalk?.label).toBe("DingTalk");
        expect(manifest.channelConfigs?.dingtalk?.schema?.type).toBe("object");
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.clientId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.agentId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.corpId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.showThinkingStream).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.asyncMode).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.clientSecret?.sensitive).toBe(true);
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.messageType?.label).toBeTruthy();
    });

    it("publishes contextVisibility in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                }
            >;
        }>("openclaw.plugin.json");

        expect(
            manifest.channelConfigs?.dingtalk?.schema?.properties?.contextVisibility,
        ).toBeDefined();
        expect(
            manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts?.additionalProperties
                ?.properties?.contextVisibility,
        ).toBeDefined();
    });

    it("publishes card streaming fields in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        expect(topLevelProperties?.cardStreamingMode).toEqual(expect.objectContaining({
            type: "string",
            enum: ["off", "answer", "all"],
        }));
        expect(topLevelProperties?.cardStreamInterval).toEqual(expect.objectContaining({
            type: "integer",
            minimum: 200,
            default: 1000,
        }));
        expect(accountLevelProperties?.cardStreamingMode).toEqual(expect.objectContaining({
            type: "string",
            enum: ["off", "answer", "all"],
        }));
        expect(accountLevelProperties?.cardStreamInterval).toEqual(expect.objectContaining({
            type: "integer",
            minimum: 200,
            default: 1000,
        }));
    });

    it("publishes card task progress fields in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                    uiHints?: Record<string, { label?: string; help?: string }>;
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        // The host validates channels.dingtalk against this schema with
        // additionalProperties: false, so an undeclared key makes the documented
        // config unusable before it ever reaches the runtime.
        for (const properties of [topLevelProperties, accountLevelProperties]) {
            expect(properties?.cardTaskProgress).toEqual(expect.objectContaining({ type: "boolean" }));
            expect(properties?.cardTaskProgressRefresh).toEqual(
                expect.objectContaining({ type: "string", enum: ["heartbeat", "interval"] }),
            );
            // No declared default on purpose: the host must keep "omitted"
            // distinguishable from an explicit value, otherwise a named account
            // could not inherit the channel-level setting.
            expect(properties?.cardTaskProgress).not.toHaveProperty("default");
            expect(properties?.cardTaskProgressRefresh).not.toHaveProperty("default");
        }

        expect(accountLevelProperties?.cardTaskProgress?.description).toBe(
            topLevelProperties?.cardTaskProgress?.description,
        );
        expect(accountLevelProperties?.cardTaskProgressRefresh?.description).toBe(
            topLevelProperties?.cardTaskProgressRefresh?.description,
        );

        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardTaskProgress?.help).toMatch(
            /progress|card/i,
        );
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardTaskProgressRefresh?.help).toMatch(
            /heartbeat|interval|throttle/i,
        );
    });

    it("documents active and legacy DingTalk config fields for WebUI operators", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                    uiHints?: Record<string, { help?: string }>;
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        expect(topLevelProperties?.cardStreamingMode?.description).toMatch(/stream|incremental|answer|reasoning/i);
        expect(topLevelProperties?.cardStreamInterval?.description).toMatch(/throttle|interval|millisecond|ms/i);
        expect(topLevelProperties?.cardRealTimeStream?.description).toMatch(/deprecated|compat/i);
        expect(topLevelProperties?.cardTemplateId?.description).toMatch(/deprecated|ignored|compat/i);
        expect(topLevelProperties?.showThinkingStream?.description).toMatch(/legacy|deprecated|compat|ignored/i);

        expect(accountLevelProperties?.cardStreamingMode?.description).toBe(
            topLevelProperties?.cardStreamingMode?.description,
        );
        expect(accountLevelProperties?.cardRealTimeStream?.description).toBe(
            topLevelProperties?.cardRealTimeStream?.description,
        );

        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardStreamingMode?.help).toMatch(
            /stream|answer|reasoning/i,
        );
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardRealTimeStream?.help).toMatch(
            /deprecated|compat/i,
        );
    });

    it("publishes gatewayCapabilities capability gates in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        // The host validates channels.dingtalk against this schema with
        // additionalProperties: false, so a missing key makes the documented
        // config unusable (and fails config load).
        for (const properties of [topLevelProperties, accountLevelProperties]) {
            expect(properties?.gatewayCapabilities).toEqual(
                expect.objectContaining({ type: "object", additionalProperties: false }),
            );
            expect(properties?.gatewayCapabilities?.properties?.tools?.properties?.docs?.type).toBe("boolean");
            expect(properties?.gatewayCapabilities?.properties?.tools?.properties?.proactiveSend?.type).toBe(
                "boolean",
            );
            expect(properties?.gatewayCapabilities?.properties?.docs?.properties?.allowedSpaceIds?.minItems).toBe(
                1,
            );
            expect(
                properties?.gatewayCapabilities?.properties?.send?.properties?.allowedTargets?.items?.pattern,
            ).toBe("^(user|group):\\S+$");
        }
    });

    it("keeps the OpenClaw compatibility metadata on the current SDK baseline", () => {
        const packageJson = readJsonFile<{
            peerDependencies?: Record<string, string>;
            openclaw?: {
                compat?: { pluginApi?: string };
                build?: { openclawVersion?: string };
                install?: { minHostVersion?: string };
            };
        }>("package.json");

        expect(packageJson.peerDependencies?.openclaw).toBe(">=2026.8.1");
        expect(packageJson.openclaw?.compat?.pluginApi).toBe(">=2026.8.1");
        expect(packageJson.openclaw?.build?.openclawVersion).toBe("2026.8.1");
        expect(packageJson.openclaw?.install?.minHostVersion).toBe(">=2026.8.1");
    });
});

describe("plugin manifest declared defaults", () => {
    type ManifestShape = {
        channelConfigs?: Record<
            string,
            {
                schema?: { properties?: Record<string, any> };
                uiHints?: Record<string, { help?: string }>;
            }
        >;
    };

    function readSchemaProperties() {
        const manifest = readJsonFile<ManifestShape>("openclaw.plugin.json");
        const topLevel = manifest.channelConfigs?.dingtalk?.schema?.properties;
        return {
            manifest,
            topLevel,
            accountLevel: topLevel?.accounts?.additionalProperties?.properties,
        };
    }

    function emptyDingTalkConfig(): OpenClawConfig {
        return { channels: { dingtalk: {} } } as unknown as OpenClawConfig;
    }

    // ClawHub's audit reads declared authority from package metadata, so a
    // capability that is off at runtime but undeclared in the manifest still
    // reads as "always on" to scanners and to the host WebUI.
    it("declares the learning defaults that the runtime resolves", () => {
        const { topLevel, accountLevel } = readSchemaProperties();
        const resolved = getConfig(emptyDingTalkConfig());

        expect(resolved.learningEnabled).toBe(false);
        expect(resolved.learningAutoApply).toBe(false);
        expect(resolved.learningNoteTtlMs).toBe(6 * 60 * 60 * 1000);
        expect(resolved.learningRuleTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
        expect(resolved.learningAllowManualGlobalRules).toBe(false);

        for (const properties of [topLevel, accountLevel]) {
            expect(properties?.learningEnabled?.default).toBe(resolved.learningEnabled);
            expect(properties?.learningAutoApply?.default).toBe(resolved.learningAutoApply);
            expect(properties?.learningNoteTtlMs?.default).toBe(resolved.learningNoteTtlMs);
            expect(properties?.learningRuleTtlMs?.default).toBe(resolved.learningRuleTtlMs);
            expect(properties?.learningAllowManualGlobalRules?.default).toBe(
                resolved.learningAllowManualGlobalRules,
            );
        }
    });

    it("declares the gateway capability defaults that the runtime resolves", () => {
        const { topLevel, accountLevel } = readSchemaProperties();
        const caps = resolveGatewayCapabilityConfig(emptyDingTalkConfig());

        expect(caps.docsEnabled).toBe(false);
        expect(caps.proactiveSendEnabled).toBe(false);

        for (const properties of [topLevel, accountLevel]) {
            const tools = properties?.gatewayCapabilities?.properties?.tools?.properties;
            expect(tools?.docs?.default).toBe(caps.docsEnabled);
            expect(tools?.proactiveSend?.default).toBe(caps.proactiveSendEnabled);
        }
    });

    it("spells out the risky defaults in descriptions and WebUI hints", () => {
        const { manifest, topLevel } = readSchemaProperties();
        const tools = topLevel?.gatewayCapabilities?.properties?.tools?.properties;

        expect(topLevel?.learningEnabled?.description).toMatch(/disabled by default/i);
        expect(topLevel?.learningAutoApply?.description).toMatch(/disabled by default/i);
        expect(tools?.docs?.description).toMatch(/disabled by default/i);
        expect(tools?.proactiveSend?.description).toMatch(/disabled by default/i);
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.learningEnabled?.help).toMatch(
            /disabled by default/i,
        );
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.["gatewayCapabilities.tools.docs"]?.help).toMatch(
            /disabled by default/i,
        );
    });

    it("documents the default exposure surface in the README", () => {
        const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

        // README stays a concise entry page: it points at the full matrix in
        // docs/user/reference/security-policies.md instead of duplicating it.
        expect(readme).toContain("默认能力面");
        expect(readme).toContain("gatewayCapabilities.tools.docs");
        expect(readme).toContain("docs/user/reference/security-policies.md");
    });
});
