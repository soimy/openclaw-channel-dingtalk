export type MarkdownImageUrlClassification = "public" | "local" | "unsupported";

export interface MarkdownImageCandidate {
  alt: string;
  url: string;
  raw: string;
  classification: MarkdownImageUrlClassification;
  start: number;
  end: number;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const PRIVATE_HOST_RE = /^(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/;

function isLikelyPlainRelativePath(url: string): boolean {
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) && !url.startsWith("//");
}

function isLikelyLocalPath(url: string): boolean {
  return url.startsWith("./") || url.startsWith("../") || url.startsWith("/") || isLikelyPlainRelativePath(url);
}

function safeFileNameFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("file://")) {
    const withoutScheme = trimmed.slice("file://".length);
    const segments = withoutScheme.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  }

  if (isLikelyLocalPath(trimmed)) {
    const segments = trimmed.split(/[\\/]/).filter(Boolean);
    return segments.at(-1) ?? "";
  }

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    return "";
  }
}

export function classifyMarkdownImageUrl(url: string): MarkdownImageUrlClassification {
  const trimmed = url.trim();
  if (!trimmed) {
    return "unsupported";
  }

  if (trimmed.startsWith("file://") || isLikelyLocalPath(trimmed)) {
    return "local";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "unsupported";
    }
    if (PRIVATE_HOST_RE.test(parsed.hostname)) {
      return "local";
    }
    return "public";
  } catch {
    return "unsupported";
  }
}

export function buildImagePlaceholderText(input: { alt: string; url: string }): string {
  const alt = input.alt.trim();
  if (alt) {
    return `见下图${alt}`;
  }

  const fileName = safeFileNameFromUrl(input.url);
  if (fileName) {
    return `见下图${fileName}`;
  }

  return "见下图图片";
}

export function extractMarkdownImageCandidates(text: string): MarkdownImageCandidate[] {
  const candidates: MarkdownImageCandidate[] = [];

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const raw = match[0] ?? "";
    const alt = match[1] ?? "";
    const url = match[2] ?? "";
    const start = match.index ?? 0;
    candidates.push({
      alt,
      url,
      raw,
      classification: classifyMarkdownImageUrl(url),
      start,
      end: start + raw.length,
    });
  }

  return candidates;
}
