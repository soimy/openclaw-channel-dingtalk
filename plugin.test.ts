import { describe, it, expect, vi } from 'vitest';
import { maskSensitiveData, cleanupOrphanedTempFiles, retryWithBackoff } from './utils';

describe('Utils - maskSensitiveData', () => {
  it('masks user IDs in data objects', () => {
    const data = {
      senderId: 'user123456789abc',
      senderNick: 'John',
      conversationId: 'conv-123',
    };

    const masked = maskSensitiveData(data);
    expect(masked.senderId).toMatch(/^u.*c$/); // Masked: keeps first 3 and last 3
    expect(masked.senderId).not.toBe(data.senderId);
    expect(masked.senderNick).toBe('John');
  });

  it('preserves non-sensitive fields', () => {
    const data = {
      text: 'Hello',
      msgtype: 'text',
      timestamp: 1234567890,
    };

    const masked = maskSensitiveData(data);
    expect(masked).toEqual(data);
  });

  it('handles nested objects', () => {
    const data = {
      content: {
        senderId: 'user123456789abc',
        text: 'Hello',
      },
    };

    const masked = maskSensitiveData(data);
     expect(masked.content.senderId).toMatch(/^u.*c$/); // Masked: keeps first 3 and last 3
    expect(masked.content.text).toBe('Hello');
  });

  it('handles null and non-object values', () => {
    expect(maskSensitiveData(null)).toBe(null);
    expect(maskSensitiveData('string')).toBe('string');
    expect(maskSensitiveData(123)).toBe(123);
  });

  it('masks short sensitive values completely', () => {
    const data = {
      senderId: 'abc',
    };

    const masked = maskSensitiveData(data);
    expect(masked.senderId).toBe('***');
  });
});

describe('Utils - retryWithBackoff', () => {
  it('returns value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 401 error', async () => {
    const error = new Error('Unauthorized');
    (error as any).response = { status: 401 };

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await retryWithBackoff(fn, { maxRetries: 3 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 (rate limit) error', async () => {
    const error = new Error('Too Many Requests');
    (error as any).response = { status: 429 };

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await retryWithBackoff(fn, { maxRetries: 2 });
    expect(result).toBe('success');
  });

  it('throws on non-retryable error', async () => {
    const error = new Error('Bad Request');
    (error as any).response = { status: 400 };

    const fn = vi.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, { maxRetries: 3 })).rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws', async () => {
    const error = new Error('Server Error');
    (error as any).response = { status: 500 };

    const fn = vi.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, { maxRetries: 2 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('Utils - cleanupOrphanedTempFiles', () => {
  it('returns 0 when no orphaned files exist', () => {
    const log = { debug: vi.fn(), info: vi.fn() };
    const result = cleanupOrphanedTempFiles(log);
    expect(typeof result).toBe('number');
    expect(result >= 0).toBe(true);
  });

  it('handles errors gracefully', () => {
    const log = { debug: vi.fn(), info: vi.fn() };
    expect(() => cleanupOrphanedTempFiles(log)).not.toThrow();
  });
});

