#!/bin/bash

# 快速设置脚本
# 用于初始化 cz-git 和 AI 提交功能

set -e

echo "🚀 开始初始化项目提交规范配置..."
echo ""

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
    echo "❌ 错误: 未找到 pnpm，请先安装 pnpm"
    echo "   npm install -g pnpm"
    exit 1
fi

echo "✓ 检测到 pnpm"
echo ""

# 安装依赖
echo "📦 安装依赖..."
pnpm install
echo "✓ 依赖安装完成"
echo ""

# 询问是否配置 AI 提交
echo "🤖 配置 AI 自动提交 (可选)"
read -p "是否要配置 OpenAI API 用于 AI 自动提交? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "请按以下步骤设置:"
    echo ""
    echo "1️⃣  获取 OpenAI API 密钥:"
    echo "   访问: https://platform.openai.com/api-keys"
    echo ""
    echo "2️⃣  创建或编辑 .env.local 文件:"
    if [ ! -f .env.local ]; then
        cp .env.example .env.local
        echo "   ✓ 已从 .env.example 创建 .env.local"
    fi
    echo ""
    echo "3️⃣  编辑 .env.local，添加你的 API 密钥:"
    echo "   nano .env.local"
    echo ""
    echo "或使用命令直接设置:"
    read -sp "请输入你的 OpenAI API 密钥 (或按 Enter 跳过): " API_KEY
    echo
    if [ -n "$API_KEY" ]; then
        echo "OPENAI_API_KEY=$API_KEY" > .env.local
        echo "✓ API 密钥已配置"
    fi
    echo ""
fi

# 验证配置
echo "✅ 配置完成！"
echo ""
echo "📚 快速命令参考:"
echo ""
echo "  pnpm commit        - 交互式规范提交"
echo "  pnpm commit:ai     - AI 自动提交（需要配置 OPENAI_API_KEY）"
echo "  pnpm type-check    - 类型检查"
echo "  pnpm lint          - 代码检查"
echo "  pnpm lint:fix      - 自动修复格式"
echo ""
echo "📖 详细文档: 查看 COMMIT_GUIDE.md"
echo ""
echo "🎉 项目已准备就绪！"
