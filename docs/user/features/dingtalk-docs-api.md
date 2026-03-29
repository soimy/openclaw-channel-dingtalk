# 钉钉文档 API

插件会额外注册一组 gateway methods，供 OpenClaw 侧直接调用钉钉文档能力。

## 当前提供的方法

- `dingtalk.docs.create`
- `dingtalk.docs.append`
- `dingtalk.docs.search`
- `dingtalk.docs.list`

## 使用要点

- `create` 支持可选 `parentId`
- `append` 使用 block API 的追加语义
- `create` 成功但首段追加失败时，仍可能返回 `ok=true`

这意味着调用方不能只检查 `ok`，还应检查：

- `partialSuccess`
- `initContentAppended`
- `appendError`

## 调用示例

```json
{
  "method": "dingtalk.docs.create",
  "params": {
    "accountId": "default",
    "spaceId": "your-space-id",
    "parentId": "optional-parent-dentry-id",
    "title": "测试文档",
    "content": "第一段内容"
  }
}
```

## 适用场景

- 在机器人流程中自动创建文档
- 向已有文档追加内容
- 搜索和列举钉钉文档资源

## 相关文档

- [配置项参考](../reference/configuration.md)
- [消息类型支持](message-types.md)
