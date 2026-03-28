# 测试与验证

仓库使用 Vitest 进行单元和集成测试。

## 运行测试

```bash
pnpm test
```

生成覆盖率：

```bash
pnpm test:coverage
```

类型检查：

```bash
npm run type-check
```

Lint：

```bash
npm run lint
```

## 当前测试约束

- 网络请求通过 mock 拦截，不访问真实钉钉 API
- 集成测试会隔离外部依赖
- 文档与 workflow 变更应额外通过 `pnpm run docs:build` 做站点级验证

## 适用建议

- 行为改动优先补测试
- 文档结构调整优先验证链接、导航和构建链路
- 合并前至少跑一次与改动范围相符的完整验证
