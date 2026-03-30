import { defineConfig } from 'vitepress'
import { applyTaskListPlugin } from './task-list-plugin'

const siteBase = '/openclaw-channel-dingtalk/'

function rewriteDocsLink(target: string): string {
  if (target === 'docs/assets/dingclaw.svg') {
    return '/assets/dingclaw.svg'
  }

  if (target === 'docs/assets/dingclaw-banner.svg') {
    return '/assets/dingclaw-banner.svg'
  }

  if (target === 'LICENSE') {
    return 'https://github.com/soimy/openclaw-channel-dingtalk/blob/main/LICENSE'
  }

  if (!target.startsWith('docs/')) {
    return target
  }

  let rewritten = `/${target.slice('docs/'.length)}`
  if (rewritten.endsWith('/index.md')) {
    rewritten = `${rewritten.slice(0, -'/index.md'.length)}/`
  } else if (rewritten.endsWith('.md')) {
    rewritten = rewritten.slice(0, -'.md'.length)
  }

  return rewritten
}

function rewriteTokenLinks(tokens: any[]): void {
  for (const token of tokens) {
    if (token.type === 'link_open') {
      const href = token.attrGet('href')
      if (typeof href === 'string') {
        token.attrSet('href', rewriteDocsLink(href))
      }
    }

    if (token.type === 'image') {
      const src = token.attrGet('src')
      if (typeof src === 'string') {
        token.attrSet('src', rewriteDocsLink(src))
      }
    }

    if (Array.isArray(token.children)) {
      rewriteTokenLinks(token.children)
    }
  }
}

function renderThemeAwareBanner(alt: string): string {
  return [
    '<span class="readme-banner-theme-switch">',
    `  <img class="banner-light" src="/assets/dingclaw-banner-light.svg" alt="${alt}">`,
    `  <img class="banner-dark" src="/assets/dingclaw-banner-dark.svg" alt="${alt}">`,
    '</span>',
  ].join('\n')
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'OpenClaw DingTalk Docs',
  description: 'OpenClaw 钉钉 Channel 插件文档',
  base: siteBase,
  srcExclude: ['archive/**', 'assets/**', 'plans/**', 'spec/**'],
  markdown: {
    config(md) {
      applyTaskListPlugin(md)

      const defaultImageRenderer =
        md.renderer.rules.image ??
        ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

      md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const src = token.attrGet('src') ?? ''

        if (src.includes('dingclaw-banner.svg')) {
          const alt = self.renderInlineAsText(token.children ?? [], options, env)
          return renderThemeAwareBanner(alt)
        }

        return defaultImageRenderer(tokens, idx, options, env, self)
      }

      md.core.ruler.after('inline', 'rewrite-readme-doc-links', (state) => {
        rewriteTokenLinks(state.tokens)

        for (const token of state.tokens) {
          if ((token.type === 'html_block' || token.type === 'html_inline') && token.content.includes('docs/assets/dingclaw-banner.svg')) {
            token.content = renderThemeAwareBanner('DingClaw Banner')
          }
        }
      })
    },
  },
  transformPageData(pageData) {
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push([
      'link',
      { rel: 'icon', type: 'image/svg+xml', href: `${siteBase}assets/dingclaw.svg` },
    ])
  },
  themeConfig: {
    logo: '/assets/dingclaw.svg',
    nav: [
      { text: '首页', link: '/' },
      { text: '用户文档', link: '/user/' },
      { text: '参与贡献', link: '/contributor/' },
      { text: '发布记录', link: '/releases/latest' },
      { text: 'English', link: '/en/' },
      { text: 'GitHub', link: 'https://github.com/soimy/openclaw-channel-dingtalk' },
    ],
    sidebar: {
      '/user/': [
        {
          text: '用户文档',
          items: [{ text: '概览', link: '/user/' }],
        },
        {
          text: '快速开始',
          items: [
            { text: '安装', link: '/user/getting-started/install' },
            { text: '更新', link: '/user/getting-started/update' },
            { text: '配置', link: '/user/getting-started/configure' },
            { text: '钉钉权限与凭证', link: '/user/getting-started/permissions' },
          ],
        },
        {
          text: '功能说明',
          items: [
            { text: '消息类型支持', link: '/user/features/message-types' },
            { text: '回复模式', link: '/user/features/reply-modes' },
            { text: 'AI 卡片', link: '/user/features/ai-card' },
            { text: '钉钉文档 API', link: '/user/features/dingtalk-docs-api' },
            { text: '反馈学习', link: '/user/features/feedback-learning' },
            { text: '多 Agent 与多机器人绑定', link: '/user/features/multi-agent-bindings' },
            { text: '@多助手路由', link: '/user/features/at-agent-routing' },
          ],
        },
        {
          text: '参考',
          items: [
            { text: '配置项', link: '/user/reference/configuration' },
            { text: '安全策略', link: '/user/reference/security-policies' },
            { text: 'API 消耗说明', link: '/user/reference/api-usage-and-cost' },
          ],
        },
        {
          text: '故障排查',
          items: [
            { text: '总览', link: '/user/troubleshooting/' },
            { text: '连接问题', link: '/user/troubleshooting/connection' },
            { text: '连接问题详解（中文）', link: '/user/troubleshooting/connection.zh-CN' },
          ],
        },
      ],
      '/contributor/': [
        {
          text: '参与贡献',
          items: [
            { text: '概览', link: '/contributor/' },
            { text: '仓库 TODO', link: '/contributor/todo' },
            { text: '本地开发', link: '/contributor/development' },
            { text: '测试与验证', link: '/contributor/testing' },
            { text: 'NPM 发布', link: '/contributor/npm-publish' },
            { text: '架构说明（中文详版）', link: '/contributor/architecture.zh-CN' },
            { text: 'Persistence API 使用指南', link: '/contributor/reference/persistence-api-usage.zh-CN' },
          ],
        },
      ],
      '/releases/': [
        {
          text: '发布记录',
          items: [
            { text: '最新版本', link: '/releases/latest' },
            { text: 'v3.4.2', link: '/releases/v3.4.2' },
            { text: 'v3.4.1', link: '/releases/v3.4.1' },
            { text: 'v3.4.0', link: '/releases/v3.4.0' },
            { text: 'v3.3.0', link: '/releases/v3.3.0' },
            { text: 'v3.2.0', link: '/releases/v3.2.0' },
          ],
        },
      ],
      '/en/': [
        {
          text: 'English',
          items: [
            { text: 'Overview', link: '/en/' },
            { text: 'Architecture guide', link: '/contributor/architecture.en' },
            { text: 'Connection troubleshooting', link: '/user/troubleshooting/connection.en' },
            { text: 'Translation TODO', link: '/en/todo' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
    editLink: {
      pattern: 'https://github.com/soimy/openclaw-channel-dingtalk/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
  },
})
