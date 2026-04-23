# DingTalk Card Markdown Image Reroute Design

## Problem

DingTalk AI Cards already render public Markdown images such as `![alt](https://example.com/a.png)`. However, local/private image references cannot be rendered directly by DingTalk card markdown and need to be uploaded as DingTalk media and inserted as `type:3` image blocks.

Today the card reply strategy only embeds images when `payload.mediaUrls` is already structured. When the answer contains Markdown image syntax, the card keeps the raw markdown as text.

## Goal

Implement a card-only reroute layer with these rules:

1. Public Markdown images stay in answer markdown untouched.
2. Local/private Markdown images are extracted into DingTalk card image blocks.
3. Extracted local/private Markdown images leave behind placeholder text in the answer: `见下图{图片标题}`.
4. Card image blocks must contain both `mediaId` and `text`.
5. On extraction/upload failure, preserve the original Markdown image text.

## Source Forms

Supported in phase 1:

- Markdown image syntax: `![alt](url)`

Out of scope for phase 1:

- Bare image URLs in plain text
- Message-tool image reroute
- Ordinary Markdown links `[text](url)`

## Classification Rules

### Public image
Treat as public when the URL:
- uses `http://` or `https://`
- is not localhost
- is not a private LAN IP (`10.x.x.x`, `172.16.x.x`–`172.31.x.x`, `192.168.x.x`)
- is not `file://`
- is not a relative or absolute local filesystem path

Public images remain in Markdown.

### Local/private image
Treat as local/private when the URL is any of:
- `file://...`
- relative path (`./`, `../`)
- absolute local filesystem path (`/tmp/a.png`)
- localhost URL
- private LAN URL

Local/private images are extracted and uploaded.

## Placeholder Rules

When a local/private Markdown image is successfully rerouted, replace the original Markdown image with placeholder text:

- preferred: `见下图{alt}`
- if `alt` is empty and a file name exists: `见下图{fileName}`
- final fallback: `见下图图片`

Examples:
- `![系统架构图](./artifacts/arch.png)` → `见下图系统架构图`
- `![](./artifacts/arch.png)` → `见下图arch.png`

## Card Block Shape

Rerouted images use card block:

```json
{ "type": 3, "mediaId": "@xxx", "text": "系统架构图" }
```

## Failure Fallback

If parsing, preparation, type detection, upload, or append fails:
- do not remove the Markdown image from answer text
- do not add the placeholder
- keep the original markdown unchanged

## Why this split is safe

- Public images already work in DingTalk markdown, so uploading them is unnecessary churn.
- Local/private images are not renderable by DingTalk clients, so converting them to media blocks improves reliability.
- Placeholder text keeps narrative continuity after extraction.
