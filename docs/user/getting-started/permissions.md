# 钉钉权限与凭证

这一页覆盖在钉钉开发者后台侧需要完成的应用创建、权限开通、卡片模板和凭证准备工作。

## 1. 创建钉钉应用

1. 访问 <https://open-dev.dingtalk.com/>
2. 创建企业内部应用
3. 添加“机器人”能力
4. 消息接收方式选择 `Stream`
5. 发布应用

## 2. 必需权限

基础能力建议至少开通：

- `Card.Instance.Write`
- `Card.Streaming.Write`
- 机器人消息发送相关权限
- 媒体文件上传相关权限

如果需要支持群聊中引用文件、视频、语音的首次恢复，还需要：

- `ConvFile.Space.Read`
- `Storage.File.Read`
- `Storage.DownloadInfo.Read`
- `Contact.User.Read`

## 3. 群文件 API 限制说明

群聊中“引用文件/视频/语音”的首次恢复，依赖群文件/钉盘 API 链路。除了权限本身，部分企业环境还可能要求企业认证。

如果看到类似错误：

```text
code=orgAuthLevelNotEnough
message=auth level of org is not enough
```

说明当前企业可能没有满足平台要求。此时：

- 单聊文件引用通常仍可工作
- 群聊首次恢复可能失败并降级为提示文本

## 4. 建立卡片模板（可选）

如果要启用 `messageType: "card"`：

1. 访问 <https://open-dev.dingtalk.com/fe/card>
2. 创建模板
3. 场景选择 “AI 卡片”
4. 保存并发布
5. 记录模板 ID
6. 记录内容字段名

如果使用 DingTalk 官方 AI 卡片模板，`cardTemplateKey` 通常为 `content`。

## 5. 准备凭证

从开发者后台获取：

- `Client ID`
- `Client Secret`
- `Robot Code`
- `Corp ID`
- `Agent ID`

## 6. 配置联动

拿到上面的信息后，继续阅读：

- [配置](configure.md)
- [配置项参考](../reference/configuration.md)
