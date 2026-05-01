# 配置

OpenClaw 支持交互式配置和手动配置文件两种方式。推荐优先使用交互式配置。

## 方式 1：交互式配置

```bash
openclaw onboard
```

或者：

```bash
openclaw configure --section channels
```

配置流程通常包括：

1. 选择 `dingtalk`
2. 选择注册方式：自动注册（浏览器扫码授权，无需手动复制凭证）或手动输入
3. 如果选择自动注册，按提示在浏览器中完成钉钉扫码授权即可自动获取 `Client ID` / `Client Secret`
4. 如果选择手动输入，输入 `Client ID` 和 `Client Secret`
5. 确认凭证与钉钉开放平台一致（`clientId` 同时用作钉钉 API 中的 robot code；无需单独填写企业 ID 或钉钉应用 ID）
6. 选择消息模式
7. 选择私聊与群聊策略

## 方式 2：手动配置文件

在 `~/.openclaw/openclaw.json` 中配置。

最小示例：

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "messageType": "markdown"
    }
  }
}
```

卡片模式示例：

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardStreamingMode": "answer",
      "cardStreamInterval": 1000
    }
  }
}
```

手动修改后需要重启：

```bash
openclaw gateway restart
```

## 配置建议

- 大多数场景先从 `messageType: "markdown"` 开始
- 如果需要流式可视化回复，再切到 `card`
- 对高风险投递场景优先使用显式 ID，而不是显示名解析

## 深入参考

- [配置项参考](../reference/configuration.md)
- [安全策略](../reference/security-policies.md)
- [回复模式](../features/reply-modes.md)
