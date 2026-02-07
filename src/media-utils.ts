// src/media-utils.ts

/**
 * Media handling utilities for DingTalk channel plugin.
 * Provides functions for media type detection and file upload to DingTalk media servers.
 */

import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import type { DingTalkConfig, Logger } from './types';

export type DingTalkMediaType = 'image' | 'voice' | 'video' | 'file';

/**
 * Detect media type from file extension
 * Matches DingTalk's supported media types:
 * - image: jpg, gif, png, bmp (max 20MB)
 * - voice: amr, mp3, wav (max 2MB)
 * - video: mp4 (max 20MB)
 * - file: doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar (max 20MB)
 *
 * @param filePath Path to the media file
 * @returns Detected media type
 */
export function detectMediaTypeFromExtension(filePath: string): DingTalkMediaType {
  const ext = path.extname(filePath).toLowerCase();

  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp'].includes(ext)) {
    return 'image';
  } else if (['.mp3', '.amr', '.wav'].includes(ext)) {
    return 'voice';
  } else if (['.mp4', '.avi', '.mov'].includes(ext)) {
    return 'video';
  }

  return 'file';
}

/**
 * File size limits for DingTalk media types (in bytes)
 */
const FILE_SIZE_LIMITS: Record<DingTalkMediaType, number> = {
  image: 20 * 1024 * 1024, // 20MB
  voice: 2 * 1024 * 1024, // 2MB
  video: 20 * 1024 * 1024, // 20MB
  file: 20 * 1024 * 1024, // 20MB
};

/**
 * Upload media file to DingTalk and get media_id
 * Uses DingTalk's media upload API: https://oapi.dingtalk.com/media/upload
 *
 * Note: Media files are stored temporarily by DingTalk (not in permanent storage).
 * The media_id can be used in subsequent message sends.
 *
 * @param config DingTalk configuration
 * @param mediaPath Local path to the media file
 * @param mediaType Type of media: 'image' | 'voice' | 'video' | 'file'
 * @param getAccessToken Function to get DingTalk access token
 * @param log Optional logger
 * @returns media_id on success, null on failure
 */
export async function uploadMedia(
  config: DingTalkConfig,
  mediaPath: string,
  mediaType: DingTalkMediaType,
  getAccessToken: (config: DingTalkConfig, log?: Logger) => Promise<string>,
  log?: Logger
): Promise<string | null> {
  let fileStream: fs.ReadStream | null = null;

  try {
    const token = await getAccessToken(config, log);

    // Check file size (stat will throw if file doesn't exist)
    const stats = await fsPromises.stat(mediaPath);
    const sizeLimit = FILE_SIZE_LIMITS[mediaType];
    if (stats.size > sizeLimit) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      const limitMB = (sizeLimit / (1024 * 1024)).toFixed(2);
      log?.error?.(`[DingTalk] Media file too large: ${sizeMB}MB exceeds ${limitMB}MB limit for ${mediaType}`);
      return null;
    }

    // Read file as a stream for better memory efficiency
    fileStream = fs.createReadStream(mediaPath);
    const filename = path.basename(mediaPath);

    // Upload to DingTalk's media server using form-data
    const form = new FormData();
    form.append('media', fileStream, { filename });

    const uploadUrl = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`;

    log?.debug?.(`[DingTalk] Uploading media: ${filename} (${stats.size} bytes) as ${mediaType}`);

    const response = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (response.data?.errcode === 0 && response.data?.media_id) {
      log?.debug?.(`[DingTalk] Media uploaded successfully: ${response.data.media_id} (${stats.size} bytes)`);
      return response.data.media_id;
    } else {
      log?.error?.(`[DingTalk] Media upload failed: ${JSON.stringify(response.data)}`);
      return null;
    }
  } catch (err: any) {
    // Handle file system errors (e.g., file not found, permission denied)
    if (err.code === 'ENOENT') {
      log?.error?.(`[DingTalk] Media file not found: ${mediaPath}`);
    } else if (err.code === 'EACCES') {
      log?.error?.(`[DingTalk] Permission denied accessing media file: ${mediaPath}`);
    } else {
      log?.error?.(`[DingTalk] Failed to upload media: ${err.message}`);
      if (axios.isAxiosError(err) && err.response) {
        log?.error?.(`[DingTalk] Upload response: ${JSON.stringify(err.response.data)}`);
      }
    }
    return null;
  } finally {
    // Ensure file stream is closed even on error
    if (fileStream) {
      fileStream.destroy();
    }
  }
}