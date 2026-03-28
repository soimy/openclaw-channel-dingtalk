# 更新

更新方式取决于你最初的安装来源。

## npm 安装来源

如果你是通过 npm 安装：

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
openclaw gateway restart
```

使用推荐的独立仓库布局时，更新插件不需要改动本地 `openclaw` 主仓库。

## 更新后建议检查

1. 重新确认 `plugins.allow` 中仍包含 `dingtalk`
2. 重启 gateway
3. 查看变更说明或发布记录

## 相关文档

- [配置](configure.md)
- [发布记录](../../releases/index.md)
