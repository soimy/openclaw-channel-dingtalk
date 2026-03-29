# 故障排查

如果插件安装成功但运行不符合预期，建议按下面顺序排查。

## 快速检查

### 收不到消息

1. 确认应用已发布
2. 确认消息接收方式为 `Stream`
3. 查看 gateway 日志

```bash
openclaw logs | grep dingtalk
```

### 群消息无响应

1. 确认机器人已加入群聊
2. 确认消息里正确 @ 了机器人
3. 确认群是企业内部群

### 安装后插件不加载

1. 确认 `plugins.allow` 中包含 `dingtalk`
2. 确认 `openclaw plugins list` 能看到插件
3. 修改配置后重启 gateway

## 详细排查入口

- [连接问题排查](connection.md)
- 详细中文手册：[connection.zh-CN.md](connection.zh-CN.md)
- 详细英文手册：[connection.en.md](connection.en.md)

## 错误 payload 日志

插件会输出统一格式的 `[ErrorPayload]` 日志，方便排查 4xx/5xx 参数问题。

建议使用：

```bash
openclaw logs | grep "\[ErrorPayload\]"
```
