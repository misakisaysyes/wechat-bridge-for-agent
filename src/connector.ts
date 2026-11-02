import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "./config.js";

export function generateWorkBuddyConnector(config: BridgeConfig): string {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const cliPath = join(projectRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) throw new Error("请先运行 npm run build，再生成 WorkBuddy 连接器");
  const dir = join(config.dataDir, "workbuddy-connector");
  const skillDir = join(dir, "skills", "wechat-push");
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  const meta = {
    name: "微信 ClawBot 桥接",
    name_zh: "微信 ClawBot 桥接",
    name_en: "WeChat ClawBot Bridge",
    description: "Send task results to a selected WeChat ClawBot conversation.",
    description_zh: "把任务结果推送到指定微信 ClawBot 会话。",
    description_en: "Send task results to a selected WeChat ClawBot conversation.",
    source: "wechat-bridge-for-agent",
    type: "mcp",
    version: "0.1.0",
    examples_zh: ["定时任务完成后，将结果推送到我的微信 ClawBot 会话"],
    examples_en: ["Send the completed scheduled task result to my WeChat ClawBot conversation"],
  };
  const mcp = {
    mcpServers: {
      "wechat-bridge-for-agent": {
        type: "stdio",
        command: process.execPath,
        args: [cliPath, "mcp"],
        cwd: projectRoot,
        env: { WECHAT_BRIDGE_DATA_DIR: config.dataDir },
        timeout: 30000,
      },
    },
  };
  writeFileSync(join(dir, "connector-meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#e9474d"/><path fill="#fff" d="M28 44h72v43H62L44 101V87H28z"/><circle cx="50" cy="66" r="6" fill="#e9474d"/><circle cx="78" cy="66" r="6" fill="#e9474d"/></svg>\n`, { mode: 0o600 });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: wechat-push\ndescription: Push completed WorkBuddy task results to a specific WeChat ClawBot conversation.\n---\n\n完成定时任务后，调用 \`push_to_wechat\`，传入任务结果、目标微信账号标识、目标联系人标识和稳定事件标识。\n\n目标标识应由创建任务的人明确指定。必要时先调用 \`list_wechat_sessions\` 查询可用会话，不要自行猜测收件会话。\n\n同一次任务执行的重试必须复用相同的 \`event_id\`。可用任务标识与本次计划执行时间组合构造。工具返回已保存表示桥接服务已持久接收，微信发送由桥接服务异步完成。\n`, { mode: 0o600 });
  return dir;
}
