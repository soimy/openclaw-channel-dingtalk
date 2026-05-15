# 更新

更新方式取决于你最初的安装来源。

## ClawHub 安装来源

如果你是通过 ClawHub 安装：

```bash
openclaw plugins update dingtalk
```

国内网络环境可临时指定镜像源：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins update dingtalk
```

如果扩展目录处于半安装状态，可补装依赖：

```bash
cd ~/.openclaw/extensions/dingtalk
rm -rf node_modules package-lock.json
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com npm install
```

## 本地源码 / 链接安装来源

如果你是通过 `openclaw plugins install -l .` 安装：

```bash
git pull
pnpm install
pnpm run build
openclaw gateway restart
```

> **注意**：v3.6.2 起，更新后必须执行 `pnpm run build` 重新编译 runtime 产物，然后重启 gateway。OpenClaw 2026.5.x 需要编译后的 `dist/index.js` 才能加载插件。

使用推荐的独立仓库布局时，更新插件不需要改动本地 `openclaw` 主仓库。

## 更新后建议检查

1. 重新确认 `plugins.allow` 中仍包含 `dingtalk`
2. 重启 gateway
3. 查看变更说明或发布记录

## 相关文档

- [配置](configure.md)
- [发布记录](../../releases/index.md)
