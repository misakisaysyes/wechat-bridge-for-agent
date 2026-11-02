import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { sendIpc } from "./ipc.js";

export async function runMcp(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({ name: "wechat-bridge-for-agent", version: "0.1.0" });
  server.registerTool("list_wechat_sessions", {
    title: "列出可推送的微信会话",
    description: "读取已与桥接服务交互的微信账号和联系人标识。主动推送时用这两个标识指定目标会话。",
  }, async () => {
    try {
      const status = await sendIpc(config, { command: "status" }) as { sessions: unknown[] };
      return { content: [{ type: "text", text: JSON.stringify(status.sessions) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  });
  server.registerTool("push_to_wechat", {
    title: "主动推送到微信 ClawBot 会话",
    description: "在任务完成后，提交任务结果到指定微信会话。event_id 必须稳定且唯一，同一任务结果重试时复用相同 event_id。桥接服务会先持久保存，再异步发送。",
    inputSchema: {
      event_id: z.string().min(1).max(256).describe("任务结果的稳定事件标识"),
      account_id: z.string().min(1).describe("目标微信账号标识"),
      contact_id: z.string().min(1).describe("目标微信联系人标识"),
      text: z.string().min(1).max(10000).describe("要发送到微信的文字内容"),
    },
  }, async ({ event_id, account_id, contact_id, text }) => {
    try {
      const result = await sendIpc(config, { command: "push", source: "workbuddy", eventId: event_id, accountId: account_id, contactId: contact_id, text });
      return { content: [{ type: "text", text: JSON.stringify({ saved: true, ...result as object }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
