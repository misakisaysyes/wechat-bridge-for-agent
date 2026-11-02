# wechat-bridge-for-agent

连接微信 ClawBot 与本机的 WorkBuddy、Codex，并将 Agent 的消息和任务结果发回微信。当前仓库处于项目初始化阶段，尚未实现微信与 Agent 的通信。实现范围和两个阶段的交付计划见 [plan.md](plan.md)。

## 本地准备

需要 Node.js 24 LTS。安装依赖后，可以初始化本地数据库并检查项目构建。

```bash
npm install
npm run dev -- init
npm run typecheck
npm run build
```

`npm start` 显示当前可用命令。`init` 命令创建 `data/bridge.sqlite` 并启用 SQLite WAL 模式。本地数据目录、环境变量文件和构建产物不会提交到 Git。可以设置 `WECHAT_BRIDGE_DATA_DIR` 指定其他数据目录。
