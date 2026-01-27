/**
 * Security and utility functions for DingTalk plugin
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Mask sensitive fields in data for safe logging
 * Prevents PII leakage in debug logs
 */
export function maskSensitiveData(data: any): any {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const masked = JSON.parse(JSON.stringify(data));
  const sensitiveFields = ['senderStaffId', 'senderId', 'senderNick', 'userId', 'token', 'accessToken', 'sessionWebhook'];

  function maskObj(obj: any): void {
    for (const key in obj) {
      if (sensitiveFields.includes(key)) {
        if (typeof obj[key] === 'string') {
          // Keep first and last 3 chars, mask the rest
          const val = obj[key] as string;
          if (val.length > 6) {
            obj[key] = val.slice(0, 3) + '*'.repeat(val.length - 6) + val.slice(-3);
          } else {
            obj[key] = '*'.repeat(val.length);
          }
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        maskObj(obj[key]);
      }
    }
  }

  maskObj(masked);
  return masked;
}

/**
 * Cleanup orphaned temp files from dingtalk media
 * Run at startup to clean up files from crashed processes
 */
export function cleanupOrphanedTempFiles(log?: any): number {
  const tempDir = os.tmpdir();
  const dingtalkPattern = /^dingtalk_\d+\..+$/;
  let cleaned = 0;

  try {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const file of files) {
      if (!dingtalkPattern.test(file)) continue;

      const filePath = path.join(tempDir, file);
      try {
        const stats = fs.statSync(filePath);
        // Delete if older than 24 hours
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
          log?.debug?.(`[DingTalk] Cleaned up orphaned temp file: ${file}`);
        }
      } catch (err: any) {
        log?.debug?.(`[DingTalk] Failed to cleanup temp file ${file}: ${err.message}`);
      }
    }

    if (cleaned > 0) {
      log?.info?.(`[DingTalk] Cleaned up ${cleaned} orphaned temp files`);
    }
  } catch (err: any) {
    log?.debug?.(`[DingTalk] Failed to cleanup temp directory: ${err.message}`);
  }

  return cleaned;
}

/**
 * Retry logic for API calls with exponential backoff
 * Handles transient failures like 401 token expiry
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; log?: any } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 100, log } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      // Check if error is retryable (401, 429, 5xx)
      const statusCode = err.response?.status;
      const isRetryable = statusCode === 401 || statusCode === 429 || (statusCode && statusCode >= 500);

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log?.debug?.(`[DingTalk] Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Retry exhausted');
}
