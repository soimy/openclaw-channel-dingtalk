import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
  },
}));

const mockedAxiosPost = vi.mocked(axios.post);

async function loadAuthModule() {
  vi.resetModules();
  return import("../../src/auth");
}

describe("auth.getAccessToken SecretInput cache path", () => {
  beforeEach(() => {
    mockedAxiosPost.mockReset();
    vi.doUnmock("../../src/config");
  });

  it("does not resolve runtime secret config on cache hit", async () => {
    const resolveRuntimeConfig = vi.fn((config) => config);
    vi.doMock("../../src/config", async () => {
      const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
      return { ...actual, resolveRuntimeConfig };
    });
    const { getAccessToken } = await loadAuthModule();
    mockedAxiosPost.mockResolvedValue({
      data: { accessToken: "token_cached", expireIn: 7200 },
    } as any);

    const config = {
      clientId: "ding_secret_ref",
      clientSecret: { source: "exec", provider: "helper", id: "client-secret" },
    } as any;
    const token1 = await getAccessToken(config);
    const token2 = await getAccessToken(config);

    expect(token1).toBe("token_cached");
    expect(token2).toBe("token_cached");
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
  });

  it("fails locally when SecretInput resolution produces no clientSecret", async () => {
    const { getAccessToken } = await loadAuthModule();

    await expect(
      getAccessToken({
        clientId: "ding_secret_ref_missing",
        clientSecret: { source: "file", provider: "local", id: "/missing" },
      } as any),
    ).rejects.toThrow("DingTalk clientId and resolved clientSecret are required");
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });
});
