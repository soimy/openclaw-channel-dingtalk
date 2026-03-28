# 安装

本文覆盖插件的主要安装方式，以及安装后最容易遗漏的信任白名单配置。

## 推荐方式

优先使用 npm 包安装：

```bash
openclaw plugins install @soimy/dingtalk
```

## 方式 A：通过 npm 包安装

适合大多数用户，升级也最直接。

```bash
openclaw plugins install @soimy/dingtalk
```

## 方式 B：通过本地源码安装

适合二次开发、调试和本地联调。

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
openclaw plugins install -l .
```

推荐的本地布局：

```text
~/Repo/openclaw                    # 用于阅读 OpenClaw 主仓库源码
~/Repo/openclaw-channel-dingtalk   # 插件开发仓库
~/.openclaw/extensions/...         # OpenClaw 管理的运行时链接
```

这种布局能避免把插件仓库塞进 OpenClaw 主仓库带来的 worktree、submodule 和 gitdir 混乱。

## 方式 C：手动安装

1. 将本仓库内容复制到 `~/.openclaw/extensions/dingtalk`
2. 确保目录中至少包含：
   - `index.ts`
   - `openclaw.plugin.json`
   - `package.json`
3. 运行：

```bash
openclaw plugins list
```

确认 `dingtalk` 已出现在插件列表中。

## 方式 D：国内网络环境安装

如果安装卡在依赖下载阶段，可临时指定 npm 镜像源：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins install @soimy/dingtalk
```

如果插件目录已存在但依赖不完整，可进入扩展目录手动补装：

```bash
cd ~/.openclaw/extensions/dingtalk
rm -rf node_modules package-lock.json
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com npm install
```

如果希望长期使用镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

## 安装后必做：配置 `plugins.allow`

从较新的 OpenClaw 版本开始，如果发现非内置插件但 `plugins.allow` 为空，会出现安全告警。建议显式声明信任的插件。

本插件的固定 id 是：

```text
dingtalk
```

示例配置：

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  }
}
```

如还有其他插件，也请一并写入白名单。

## 安装后验证

```bash
openclaw plugins list
openclaw gateway restart
```

## 下一步

- 继续阅读：[更新](update.md)
- 继续阅读：[配置](configure.md)
- 继续阅读：[钉钉权限与凭证](permissions.md)
