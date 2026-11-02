import { createServer, createConnection, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { BridgeConfig } from "./config.js";
import type { Repository } from "./storage/repository.js";

type IpcCommand =
  | { command: "push"; source: string; eventId: string; accountId: string; contactId: string; text: string }
  | { command: "status" };

function respond(repo: Repository, command: IpcCommand): unknown {
  if (command.command === "push") {
    for (const value of [command.source, command.eventId, command.accountId, command.contactId, command.text]) {
      if (typeof value !== "string" || !value.trim()) throw new Error("推送参数不能为空");
    }
    if (command.text.length > 10000 || command.eventId.length > 256) throw new Error("推送内容或事件标识过长");
    return repo.enqueueEvent(command);
  }
  if (command.command === "status") return {
    accounts: repo.listAccounts().map(({ id, state, user_id }) => ({ id, state, user_id })),
    sessions: repo.listSessions().map(({ account_id, contact_id, context_token }) => ({ account_id, contact_id, has_context: !!context_token, target_agent: repo.getSelectedAgent(account_id, contact_id) ?? "workbuddy" })),
    requests: repo.listRequests().map(({ id, account_id, contact_id, state, last_error }) => ({ id, account_id, contact_id, state, last_error })),
    outbox: repo.listOutbox().map(({ id, account_id, contact_id, status, attempts }) => ({ id, account_id, contact_id, status, attempts })),
    workbuddyAuthorized: !!repo.getCredential(),
  };
  throw new Error("未知本地命令");
}

export async function startIpc(config: BridgeConfig, repo: Repository): Promise<Server> {
  if (process.platform !== "win32" && existsSync(config.socketPath)) {
    try { await sendIpc(config, { command: "status" }); throw new Error("桥接服务已在运行"); }
    catch (error) {
      if (error instanceof Error && error.message === "桥接服务已在运行") throw error;
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ECONNREFUSED") throw error;
      unlinkSync(config.socketPath);
    }
  }
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      try {
        const result = respond(repo, JSON.parse(line) as IpcCommand);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => { server.off("error", reject); resolve(); });
  });
  if (process.platform !== "win32") chmodSync(config.socketPath, 0o600);
  return server;
}

export async function sendIpc(config: BridgeConfig, command: IpcCommand): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("本地通信超时")));
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { ok: boolean; result?: unknown; error?: string };
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error ?? "本地通信失败"));
      } catch (error) { reject(error); }
      socket.end();
    });
  });
}
