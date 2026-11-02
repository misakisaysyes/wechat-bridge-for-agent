import { setTimeout as sleep } from "node:timers/promises";
import type { BridgeConfig } from "./config.js";
import { IlinkClient, IlinkError, type IlinkMessage } from "./ilink/client.js";
import { startIpc } from "./ipc.js";
import { Repository, type UserRequest } from "./storage/repository.js";
import { WorkBuddyClient, WorkBuddyError } from "./workbuddy/client.js";

function log(message: string): void { process.stderr.write(`[${new Date().toISOString()}] ${message}\n`); }
function retryDelay(attempts: number): number { return Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9)); }

export function inboundText(message: IlinkMessage): string | null {
  const items = message.item_list?.filter((item) => item.type === 1 && typeof item.text_item?.text === "string") ?? [];
  const text = items.map((item) => item.text_item?.text ?? "").join("\n").trim();
  return text || null;
}

export function routeWorkBuddy(text: string): { accepted: boolean; text: string } {
  if (text === "/workbuddy") return { accepted: false, text: "" };
  if (text.startsWith("/workbuddy ")) return { accepted: true, text: text.slice(11).trim() };
  if (text.startsWith("/")) return { accepted: false, text: "" };
  return { accepted: true, text };
}

async function pollAccount(repo: Repository, accountId: string, signal: AbortSignal): Promise<void> {
  const client = new IlinkClient();
  let errors = 0;
  while (!signal.aborted) {
    const account = repo.getAccount(accountId);
    if (!account || account.state !== "active") return;
    try {
      const response = await client.getUpdates(account, signal);
      errors = 0;
      for (const message of response.msgs ?? []) {
        const contactId = message.from_user_id;
        if (!contactId || !message.message_id) continue;
        // Stage One is scoped to the WeChat user who bound this bot.
        if (account.user_id && contactId !== account.user_id) continue;
        const text = inboundText(message);
        if (!text) { repo.recordSessionOnly(accountId, contactId, message.message_id, message.context_token); continue; }
        if (text === "/workbuddy") {
          if (repo.recordSessionOnly(accountId, contactId, message.message_id, message.context_token)) {
            repo.selectAgent(accountId, contactId, "workbuddy");
            repo.enqueueEvent({ source: "bridge", eventId: `select:${accountId}:${message.message_id}`,
              accountId, contactId, text: "已选择 WorkBuddy，请发送你的请求。" });
          }
          continue;
        }
        const routed = routeWorkBuddy(text);
        if (!routed.accepted || !routed.text) {
          repo.recordSessionOnly(accountId, contactId, message.message_id, message.context_token);
          continue;
        }
        const added = repo.recordInbound(accountId, contactId, message.message_id, routed.text, message.context_token);
        if (added && text.startsWith("/workbuddy ")) repo.selectAgent(accountId, contactId, "workbuddy");
        if (added) log(`微信请求已保存: ${accountId}/${contactId} ${message.message_id}`);
      }
      if (response.get_updates_buf) repo.saveCursor(accountId, response.get_updates_buf);
      if (!response.msgs?.length) await sleep(250);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof IlinkError && error.kind === "login") {
        repo.setAccountState(accountId, "needs_login");
        log(`微信账号 ${accountId} 需重新扫码登录`);
        return;
      }
      if (error instanceof IlinkError && error.kind === "pause") {
        repo.pauseAccount(accountId, 60 * 60_000);
        log(`微信账号 ${accountId} 暂停轮询一小时`);
        return;
      }
      errors += 1;
      log(`微信轮询失败 (${accountId}): ${String(error)}`);
      await sleep(retryDelay(errors));
    }
  }
}

async function pollAccounts(repo: Repository, signal: AbortSignal): Promise<void> {
  const running = new Map<string, Promise<void>>();
  while (!signal.aborted) {
    for (const account of repo.listAccounts()) {
      if (account.state === "paused" && account.resume_at <= Date.now()) repo.resumeAccount(account.id);
      if (account.state !== "active" || running.has(account.id)) continue;
      const task = pollAccount(repo, account.id, signal).finally(() => running.delete(account.id));
      running.set(account.id, task);
    }
    await sleep(3000);
  }
  await Promise.allSettled(running.values());
}

export async function processWorkBuddyRequest(repo: Repository, client: WorkBuddyClient, request: UserRequest): Promise<void> {
  if (request.state === "uncertain") return;
  if (request.state === "queued") {
    try {
      if (!await client.isOnline()) {
        repo.setRequestState(request.id, "queued", { nextPollAt: Date.now() + 15_000, error: "WorkBuddy 本地助理离线" });
        return;
      }
      repo.setRequestState(request.id, "sending");
      const messageId = await client.sendText(request.text);
      repo.setRequestState(request.id, "awaiting_reply", { agentMessageId: messageId, replyCursor: messageId, nextPollAt: Date.now() + 3000 });
      log(`WorkBuddy 请求已提交: ${request.id}`);
    } catch (error) {
      if (error instanceof WorkBuddyError && error.kind === "uncertain") {
        repo.setRequestState(request.id, "uncertain", { error: error.message });
      } else {
        repo.setRequestState(request.id, "queued", { nextPollAt: Date.now() + 15_000, error: String(error) });
      }
    }
    return;
  }
  if (request.state !== "awaiting_reply" || !request.agent_message_id) return;
  try {
    const messages = await client.messagesAfter(request.reply_cursor ?? request.agent_message_id);
    let cursor = request.reply_cursor ?? request.agent_message_id;
    let lastReplyAt = request.last_reply_at ?? undefined;
    for (const message of messages) {
      if (!message.message_id) continue;
      cursor = message.message_id;
      if (message.role !== "assistant") continue;
      const text = message.content.filter((part): part is string => typeof part === "string").join("\n").trim();
      if (!text) continue;
      repo.enqueueReply(request, message.message_id, text);
      lastReplyAt = Date.now();
    }
    if (messages.length === 0 && lastReplyAt && Date.now() - lastReplyAt > 30_000) {
      repo.setRequestState(request.id, "complete", { replyCursor: cursor, lastReplyAt });
      return;
    }
    repo.setRequestState(request.id, "awaiting_reply", { replyCursor: cursor, lastReplyAt, nextPollAt: Date.now() + 3000 });
  } catch (error) {
    repo.setRequestState(request.id, "awaiting_reply", { nextPollAt: Date.now() + 10_000, error: String(error) });
  }
}

async function workBuddyLoop(repo: Repository, config: BridgeConfig, signal: AbortSignal): Promise<void> {
  const client = new WorkBuddyClient(config, repo);
  while (!signal.aborted) {
    const active = repo.activeRequest();
    const request = active ?? repo.nextRequest();
    if (request && request.next_poll_at <= Date.now()) await processWorkBuddyRequest(repo, client, request);
    await sleep(request ? 1000 : 3000);
  }
}

async function outboxLoop(repo: Repository, signal: AbortSignal): Promise<void> {
  const client = new IlinkClient();
  while (!signal.aborted) {
    const message = repo.nextOutbox();
    if (!message) { await sleep(1000); continue; }
    const account = repo.getAccount(message.account_id);
    const session = repo.getSession(message.account_id, message.contact_id);
    if (!account || account.state !== "active") {
      repo.setOutboxState(message.id, "needs_login", "微信账号未登录");
      continue;
    }
    if (!session?.context_token) {
      repo.setOutboxState(message.id, "waiting_context", "等待该微信会话的新消息");
      continue;
    }
    repo.setOutboxState(message.id, "sending");
    try {
      await client.sendText(account, message.contact_id, session.context_token, message.text, message.client_id);
      repo.setOutboxState(message.id, "accepted");
      log(`微信消息已接受: ${message.id}`);
    } catch (error) {
      if (error instanceof IlinkError && error.kind === "context") {
        repo.setOutboxState(message.id, "waiting_context", error.message);
      } else if (error instanceof IlinkError && error.kind === "login") {
        repo.setAccountState(message.account_id, "needs_login");
        repo.setOutboxState(message.id, "needs_login", error.message);
      } else if (error instanceof IlinkError && error.kind === "pause") {
        repo.pauseAccount(message.account_id, 60 * 60_000);
        repo.setOutboxState(message.id, "retry_wait", error.message, 60 * 60_000);
      } else if (error instanceof IlinkError && error.kind === "uncertain") {
        repo.setOutboxState(message.id, "uncertain", error.message);
      } else {
        repo.setOutboxState(message.id, "retry_wait", String(error), retryDelay(message.attempts));
      }
    }
    await sleep(1500);
  }
}

export async function runDaemon(config: BridgeConfig, repo: Repository): Promise<void> {
  repo.recoverRequests();
  repo.recoverOutbox();
  const server = await startIpc(config, repo);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`桥接服务已启动，IPC: ${config.socketPath}`);
  try {
    await Promise.all([pollAccounts(repo, controller.signal), workBuddyLoop(repo, config, controller.signal), outboxLoop(repo, controller.signal)]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log("桥接服务已停止");
  }
}
