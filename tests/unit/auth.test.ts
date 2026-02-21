import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
    default: {
        post: vi.fn(),
    },
}));

const mockedAxiosPost = vi.mocked(axios.post);

async function loadAuthModule() {
    vi.resetModules();
    return import('../../src/auth');
}

describe('auth.getAccessToken', () => {
    beforeEach(() => {
        mockedAxiosPost.mockReset();
    });

    it('returns cached token for same clientId before expiry', async () => {
        const { getAccessToken } = await loadAuthModule();
        mockedAxiosPost.mockResolvedValue({ data: { accessToken: 'token_a', expireIn: 7200 } } as any);

        const config = { clientId: 'ding_id', clientSecret: 'ding_secret' } as any;
        const token1 = await getAccessToken(config);
        const token2 = await getAccessToken(config);

        expect(token1).toBe('token_a');
        expect(token2).toBe('token_a');
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    });

    it('retries on transient 401 and succeeds', async () => {
        vi.useFakeTimers();
        const { getAccessToken } = await loadAuthModule();

        mockedAxiosPost
            .mockRejectedValueOnce({ response: { status: 401 }, message: 'unauthorized' })
            .mockResolvedValueOnce({ data: { accessToken: 'token_retry', expireIn: 7200 } } as any);

        const promise = getAccessToken({ clientId: 'ding_retry', clientSecret: 'sec' } as any);
        await vi.advanceTimersByTimeAsync(120);
        const token = await promise;

        expect(token).toBe('token_retry');
        expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('throws on non-retryable failure', async () => {
        const { getAccessToken } = await loadAuthModule();
        mockedAxiosPost.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });

        await expect(getAccessToken({ clientId: 'ding_err', clientSecret: 'sec' } as any)).rejects.toBeDefined();
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    });
});
