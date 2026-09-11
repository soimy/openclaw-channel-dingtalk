/**
 * Verifies that DingTalk reads one allowlisted environment secret at a time
 * through the host read-only guard instead of handing the whole ambient
 * `process.env` object to the secret resolver.
 *
 * Only the host's configured/file resolver is mocked here; the read-only
 * authorization guard (`canResolveEnvSecretRefInReadOnlyPath`) and the literal
 * inspection path run against the real SDK.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveConfiguredSecretInputStringMock = vi.fn();

vi.mock("openclaw/plugin-sdk/secret-input-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/secret-input-runtime")>();
  return {
    ...actual,
    resolveConfiguredSecretInputString: (...args: unknown[]) =>
      resolveConfiguredSecretInputStringMock(...args),
  };
});

import {
  resolveDingTalkSecretConfig,
  resolveSecretInputStringWithFailure,
} from "../../src/secret-input";

const ALLOWLISTED_VAR = "DINGTALK_TEST_ALLOWLISTED_SECRET";
const UNAUTHORIZED_VAR = "DINGTALK_TEST_UNAUTHORIZED_SECRET";
const UNSET_VAR = "DINGTALK_TEST_UNSET_SECRET";

describe("SecretInput env isolation", () => {
  beforeEach(() => {
    resolveConfiguredSecretInputStringMock.mockReset();
    delete process.env[ALLOWLISTED_VAR];
    delete process.env[UNAUTHORIZED_VAR];
    delete process.env[UNSET_VAR];
  });

  function allowlistedConfig(id: string) {
    return {
      secrets: {
        providers: {
          env: { source: "env", allowlist: [id] },
        },
      },
    };
  }

  it("reads one allowlisted env variable and returns its value", async () => {
    process.env[ALLOWLISTED_VAR] = "  resolved-secret  ";

    const resolved = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "env", id: ALLOWLISTED_VAR },
      undefined,
      allowlistedConfig(ALLOWLISTED_VAR) as any,
    );

    expect(resolved.value).toBe("resolved-secret");
    expect(resolved.failure).toBeUndefined();
    // The env branch never falls back to the file/config resolver.
    expect(resolveConfiguredSecretInputStringMock).not.toHaveBeenCalled();
  });

  it("fails closed when the allowlist does not cover the variable", async () => {
    process.env[ALLOWLISTED_VAR] = "ambient-secret";

    const resolved = await resolveDingTalkSecretConfig(
      {
        clientId: "ding-client-id",
        clientSecret: { source: "env", provider: "env", id: ALLOWLISTED_VAR },
      },
      undefined,
    );

    // The allowlist for this config covers a different id, so the ambient value is not used.
    expect(resolved.clientSecret).toBeUndefined();
    expect(resolved.clientSecretResolutionFailure).toMatchObject({
      source: "env",
      provider: "env",
      id: ALLOWLISTED_VAR,
    });
    expect(resolveConfiguredSecretInputStringMock).not.toHaveBeenCalled();
  });

  it("distinguishes an unauthorized variable from an authorized but unset one", async () => {
    const unauthorized = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "env", id: UNAUTHORIZED_VAR },
      undefined,
      allowlistedConfig(ALLOWLISTED_VAR) as any,
    );
    const unset = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "env", id: UNSET_VAR },
      undefined,
      allowlistedConfig(UNSET_VAR) as any,
    );

    expect(unauthorized.failure?.reason).toContain("is not authorized for a read-only path");
    expect(unset.failure?.reason).toContain("is authorized but unset or empty");
    expect(unset.failure?.reason).not.toContain("include");
  });

  it("treats a whitespace-only variable as unset rather than resolved", async () => {
    process.env[UNSET_VAR] = "   ";

    const resolved = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "env", id: UNSET_VAR },
      undefined,
      allowlistedConfig(UNSET_VAR) as any,
    );

    expect(resolved.value).toBeUndefined();
    expect(resolved.failure?.reason).toContain("is authorized but unset or empty");
  });

  it("accepts a built-in default env provider when no provider is declared", async () => {
    process.env[ALLOWLISTED_VAR] = "default-provider-secret";

    const resolved = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "default", id: ALLOWLISTED_VAR },
      undefined,
      {} as any,
    );

    expect(resolved.value).toBe("default-provider-secret");
  });

  it("rejects an env ref whose provider is declared with another source", async () => {
    const resolved = await resolveSecretInputStringWithFailure(
      { source: "env", provider: "local", id: ALLOWLISTED_VAR },
      undefined,
      {
        secrets: {
          providers: {
            local: { source: "file", path: "/var/lib/openclaw/client-secret" },
          },
        },
      } as any,
    );

    expect(resolved.value).toBeUndefined();
    expect(resolved.failure?.reason).toContain('has source "file" but the ref requests "env"');
  });

  it("keeps file SecretInput resolution on a scoped resolver with an empty env", async () => {
    resolveConfiguredSecretInputStringMock.mockResolvedValue({ value: "file-secret" });

    const hostConfig = {
      secrets: {
        providers: {
          local: { source: "file", path: "/var/lib/openclaw/client-secret", mode: "singleValue" },
        },
      },
    };

    const resolved = await resolveSecretInputStringWithFailure(
      { source: "file", provider: "local", id: "value" },
      undefined,
      hostConfig as any,
    );

    expect(resolved.value).toBe("file-secret");
    expect(resolveConfiguredSecretInputStringMock).toHaveBeenCalledTimes(1);

    const call = resolveConfiguredSecretInputStringMock.mock.calls[0][0] as {
      config: unknown;
      env: unknown;
    };
    expect(call.config).toBe(hostConfig);
    // An empty env keeps ambient variables out of the file branch.
    expect(call.env).toEqual({});
  });
});
