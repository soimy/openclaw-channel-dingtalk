# Persistence API 使用指南（DingTalk 插件）

本文档细化 `src/persistence-store.ts` 的使用方法，覆盖接口说明、命名规范、scope 设计、迁移模板与常见坑。

## 1. 设计目标

- 统一插件内持久化路径约定（基于 namespace + scope）。
- 提供容错读取（文件不存在、空文件、JSON 解析失败均可回退）。
- 提供原子写入（`tmp + rename`）降低中断导致的数据损坏风险。
- 保持调用侧简单：读写都围绕 `namespace` 与 `storePath`。

## 2. 核心接口

文件：`src/persistence-store.ts`

```ts
type NamespaceFormat = "json";

interface PersistenceScope {
  accountId?: string;
  agentId?: string;
  conversationId?: string;
  groupId?: string;
  targetId?: string;
}

function resolveNamespacePath(
  namespace: string,
  options: {
    storePath: string;
    scope?: PersistenceScope;
    format?: NamespaceFormat;
  },
): string;

function readNamespaceJson<T>(
  namespace: string,
  options: {
    storePath: string;
    scope?: PersistenceScope;
    format?: NamespaceFormat;
    fallback: T;
    log?: Logger;
  },
): T;

function writeNamespaceJsonAtomic<T>(
  namespace: string,
  options: {
    storePath: string;
    scope?: PersistenceScope;
    format?: NamespaceFormat;
    data: T;
    log?: Logger;
  },
): void;
```

## 3. 路径解析规则

`resolveNamespacePath()` 规则如下：

1. 根目录：`path.dirname(storePath) + "/dingtalk-state"`
2. 文件名：`<namespace><scope-suffix>.<format>`（默认 `json`）
3. `namespace` 中的非字母数字字符会被替换为 `_`；`scope` 的各字段值会以 base64url 编码后参与拼接，而不会按字符替换为 `_`
4. `scope` 拼接顺序固定：
   - `accountId`
   - `agentId`
   - `conversationId`
   - `groupId`
   - `targetId`

示例：

```ts
const p = resolveNamespacePath("cards.active.pending", {
  storePath: "/tmp/openclaw/session/main/session.json",
  scope: { accountId: "main", conversationId: "cid_xxx" },
});

// 结果类似：
// /tmp/openclaw/session/main/dingtalk-state/
// cards.active.pending.account-bWFpbg.conversation-Y2lkX3h4eA.json
```

## 4. 读写最佳实践

### 4.1 读取：总是提供结构化 fallback

```ts
type PendingState = {
  version: number;
  records: Array<{ accountId: string; conversationId: string }>;
};

const fallback: PendingState = { version: 1, records: [] };

const state = readNamespaceJson<PendingState>("cards.active.pending", {
  storePath,
  scope: { accountId },
  fallback,
  log,
});
```

建议：

- `fallback` 保持最小可运行结构（不要传 `null`/`undefined`）。
- 读取后优先做轻量 schema 校验（尤其是跨版本数据）。

### 4.2 写入：只写最终态，避免高频抖动

```ts
writeNamespaceJsonAtomic("cards.active.pending", {
  storePath,
  scope: { accountId },
  data: state,
  log,
});
```

建议：

- 高频更新场景先做内存聚合，再批量落盘。
- 数据大于预期时，考虑拆 namespace（避免单文件无限增长）。

## 5. Scope 设计建议

### 5.1 推荐策略

- 跨账号状态必须包含 `accountId`。
- 会话级状态建议包含 `accountId + conversationId`。
- 群级状态建议包含 `accountId + groupId`。
- 主动消息目标建议包含 `accountId + targetId`。

### 5.2 典型 namespace 建议

- `cards.active.pending`：账号维度（可附会话维度）
- `members.group-roster`：账号 + 群维度
- `quoted.msg-download-code`：账号 + 会话维度
- `cards.content.quote-lookup`：账号 + 会话维度

## 6. 迁移模板（legacy -> namespace）

当已有历史文件格式时，推荐「新路径优先读，旧路径兜底读，成功后回填新路径」：

```ts
function loadWithLegacyFallback<T>(params: {
  namespace: string;
  storePath: string;
  scope: PersistenceScope;
  fallback: T;
  readLegacy: () => T | null;
  log?: Logger;
}): T {
  const nextData = readNamespaceJson<T>(params.namespace, {
    storePath: params.storePath,
    scope: params.scope,
    fallback: params.fallback,
    log: params.log,
  });

  // nextData 不是 fallback 时，直接返回
  if (JSON.stringify(nextData) !== JSON.stringify(params.fallback)) {
    return nextData;
  }

  const legacy = params.readLegacy();
  if (legacy === null) {
    return nextData;
  }

  writeNamespaceJsonAtomic(params.namespace, {
    storePath: params.storePath,
    scope: params.scope,
    data: legacy,
    log: params.log,
  });

  return legacy;
}
```

迁移注意：

- 迁移期不要立即删除 legacy 文件。
- 至少经历一个发布周期后再评估是否清理。

## 7. Process-local 状态边界

以下状态建议保持 memory-only，不应使用 persistence-api 落盘：

- `dedup.processed-message`
- `session.lock`
- `channel.inflight`

原因：这些状态是并发控制语义，跨进程/重启持久化会引入锁漂移和一致性问题。

## 8. 常见问题

### Q1: 为什么读取失败不抛错？

`readNamespaceJson()` 设计为容错优先：读取失败会记录 warn 并返回 fallback，避免影响主流程可用性。

### Q2: namespace 可以包含特殊字符吗？

可以传入，但最终文件名会做 `sanitize`，非法字符会被替换为 `_`。

### Q3: 是否支持 JSON 之外格式？

当前仅支持 `json`（`NamespaceFormat = "json"`）。

## 9. 最小接入清单

新增一个可持久化状态时，建议按以下顺序：

1. 设计 namespace 与 scope（先定维度）。
2. 定义 fallback 结构与版本字段（如 `version`）。
3. 接入 `readNamespaceJson()` 与 `writeNamespaceJsonAtomic()`。
4. 补单测：
   - 读取 fallback
   - 读取损坏 JSON 回退
   - 写入后可读
   - （如有迁移）legacy -> namespace 回填
5. 确认不误用到 process-local 状态。
