import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { inboundText, processWorkBuddyRequest, routeWorkBuddy } from "../src/daemon.js";
import { IlinkClient, IlinkError } from "../src/ilink/client.js";
import { sendIpc, startIpc } from "../src/ipc.js";
import { Repository } from "../src/storage/repository.js";
import { openDatabase } from "../src/storage/sqlite.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wechat-bridge-test-"));
  dirs.push(dir);
  const config = loadConfig({ WECHAT_BRIDGE_DATA_DIR: dir });
  const db = openDatabase(config.databasePath);
  const repo = new Repository(db);
  repo.saveAccount({ id: "bot-1", botToken: "secret", baseUrl: "https://ilinkai.weixin.qq.com", userId: "person-1" });
  return { dir, config, db, repo };
}

test("inbound messages are deduplicated and replies retain their source conversation", () => {
  const { db, repo } = fixture();
  assert.deepEqual(routeWorkBuddy("/workbuddy 你好"), { accepted: true, text: "你好" });
  assert.equal(inboundText({ item_list: [{ type: 1, text_item: { text: "你好" } }] }), "你好");
  assert.equal(repo.recordInbound("bot-1", "person-1", "wx-1", "你好", "token-1"), true);
  assert.equal(repo.recordInbound("bot-1", "person-1", "wx-1", "你好", "token-old"), false);
  assert.equal(repo.getSession("bot-1", "person-1")?.context_token, "token-1");
  repo.selectAgent("bot-1", "person-1", "workbuddy");
  assert.equal(repo.getSelectedAgent("bot-1", "person-1"), "workbuddy");
  const request = repo.nextRequest();
  assert.ok(request);
  repo.enqueueReply(request, "wb-reply-1", "回复");
  repo.enqueueReply(request, "wb-reply-1", "回复");
  const outbox = repo.listOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.account_id, "bot-1");
  assert.equal(outbox[0]?.contact_id, "person-1");
  assert.equal(outbox[0]?.text, "回复");
  db.close();
});

test("proactive push survives context expiry, relogin, and database reopen", () => {
  const { config, db, repo } = fixture();
  repo.recordSessionOnly("bot-1", "person-1", "wx-1", "token-1");
  const created = repo.enqueueEvent({ source: "workbuddy", eventId: "task-1/run-1", accountId: "bot-1", contactId: "person-1", text: "定时结果" });
  assert.equal(created.duplicate, false);
  assert.equal(repo.enqueueEvent({ source: "workbuddy", eventId: "task-1/run-1", accountId: "bot-1", contactId: "person-1", text: "定时结果" }).duplicate, true);
  assert.throws(() => repo.enqueueEvent({ source: "workbuddy", eventId: "task-1/run-1", accountId: "bot-1", contactId: "person-1", text: "不同结果" }));
  const message = repo.nextOutbox();
  assert.ok(message);
  repo.setOutboxState(message.id, "waiting_context", "ret=-2");
  assert.equal(repo.nextOutbox(), undefined);
  assert.equal(repo.recordSessionOnly("bot-1", "person-1", "wx-2", "token-2"), true);
  assert.equal(repo.nextOutbox()?.id, message.id);
  repo.setAccountState("bot-1", "needs_login");
  assert.equal(repo.nextOutbox(), undefined);
  db.close();
  const reopened = openDatabase(config.databasePath);
  const saved = new Repository(reopened);
  assert.equal(saved.listOutbox()[0]?.status, "needs_login");
  saved.saveAccount({ id: "bot-1", botToken: "new-secret", baseUrl: "https://ilinkai.weixin.qq.com", userId: "person-1" });
  assert.equal(saved.nextOutbox()?.id, message.id);
  reopened.close();
});

test("an interrupted send remains uncertain until explicitly resolved", () => {
  const { db, repo } = fixture();
  repo.recordSessionOnly("bot-1", "person-1", "wx-1", "token-1");
  repo.enqueueEvent({ source: "workbuddy", eventId: "task-2", accountId: "bot-1", contactId: "person-1", text: "结果" });
  const message = repo.nextOutbox();
  assert.ok(message);
  repo.setOutboxState(message.id, "sending");
  repo.recoverOutbox();
  assert.equal(repo.listOutbox()[0]?.status, "uncertain");
  assert.equal(repo.nextOutbox(), undefined);
  repo.resolveOutbox(message.id, "queued");
  assert.equal(repo.nextOutbox()?.id, message.id);
  db.close();
});

test("a temporarily limited WeChat account pauses queued sends and resumes later", () => {
  const { db, repo } = fixture();
  repo.recordSessionOnly("bot-1", "person-1", "wx-1", "token-1");
  repo.enqueueEvent({ source: "workbuddy", eventId: "task-paused", accountId: "bot-1", contactId: "person-1", text: "结果" });
  assert.ok(repo.nextOutbox());
  repo.pauseAccount("bot-1", 60 * 60_000);
  assert.equal(repo.nextOutbox(), undefined);
  db.prepare("UPDATE wechat_accounts SET resume_at=0 WHERE id='bot-1'").run();
  repo.resumeAccount("bot-1");
  assert.ok(repo.nextOutbox());
  db.close();
});

test("local IPC durably accepts one event per stable event id", async () => {
  const { config, db, repo } = fixture();
  repo.recordSessionOnly("bot-1", "person-1", "wx-1", "token-1");
  const server = await startIpc(config, repo);
  try {
    const command = { command: "push" as const, source: "workbuddy", eventId: "scheduled-1", accountId: "bot-1", contactId: "person-1", text: "任务完成" };
    assert.equal((await sendIpc(config, command) as { duplicate: boolean }).duplicate, false);
    assert.equal((await sendIpc(config, command) as { duplicate: boolean }).duplicate, true);
    assert.equal(repo.listOutbox().length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("WorkBuddy MCP tool submits a scheduled result through local IPC", async () => {
  const { config, db, repo } = fixture();
  repo.recordSessionOnly("bot-1", "person-1", "wx-1", "token-1");
  const ipc = await startIpc(config, repo);
  const mcp = new Client({ name: "bridge-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "mcp"],
    cwd: process.cwd(),
    env: { ...process.env, WECHAT_BRIDGE_DATA_DIR: config.dataDir } as Record<string, string>,
  });
  try {
    await mcp.connect(transport);
    const result = await mcp.callTool({ name: "push_to_wechat", arguments: {
      event_id: "task-1:scheduled-time", account_id: "bot-1", contact_id: "person-1", text: "任务结果",
    } });
    assert.equal(result.isError, undefined);
    assert.equal(repo.listOutbox()[0]?.text, "任务结果");
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => ipc.close(() => resolve()));
    db.close();
  }
});

test("iLink send uses the conversation token and classifies ret=-2", async () => {
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ret: -2, errmsg: "stale" }), { status: 200 });
  };
  try {
    await assert.rejects(new IlinkClient().sendText({ base_url: "https://ilinkai.weixin.qq.com", bot_token: "secret" }, "person-1", "token-1", "hello", "client-1"),
      (error: unknown) => error instanceof IlinkError && error.kind === "context");
    assert.equal(body.msg.to_user_id, "person-1");
    assert.equal(body.msg.context_token, "token-1");
    assert.equal(body.msg.client_id, "client-1");
  } finally { globalThis.fetch = originalFetch; }
});

test("iLink polling detects a one-hour pause from errcode even when ret is zero", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ret: 0, errcode: -14, msgs: [] }), { status: 200 });
  try {
    await assert.rejects(new IlinkClient().getUpdates({ base_url: "https://ilinkai.weixin.qq.com", bot_token: "secret", cursor: "" }),
      (error: unknown) => error instanceof IlinkError && error.kind === "pause");
  } finally { globalThis.fetch = originalFetch; }
});

test("WorkBuddy Open API sends text and polls after the returned message id", async () => {
  const { config, db, repo } = fixture();
  repo.saveCredential({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000, open_id: "open-1", scope: "user.localassistant.readable user.localassistant.invokable" });
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body?.toString() });
    if (url.endsWith("/localassistant")) return new Response(JSON.stringify({ code: 0, data: { online: true } }));
    if (init?.method === "POST") return new Response(JSON.stringify({ code: 0, data: { message_id: "wb-1" } }));
    return new Response(JSON.stringify({ code: 0, data: { messages: [{ message_id: "wb-2", role: "assistant", content: ["完成"] }] } }));
  };
  try {
    const client = new WorkBuddyClient(config, repo);
    assert.equal(await client.isOnline(), true);
    assert.equal(await client.sendText("你好"), "wb-1");
    assert.equal((await client.messagesAfter("wb-1"))[0]?.message_id, "wb-2");
    assert.equal(JSON.parse(calls[1]?.body ?? "{}").msg_type, "text");
    assert.ok(calls[2]?.url.includes("message_id=wb-1"));
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("WorkBuddy reply is queued for the originating WeChat conversation", async () => {
  const { config, db, repo } = fixture();
  repo.recordInbound("bot-1", "person-1", "wx-1", "帮我处理", "token-1");
  repo.saveCredential({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000, open_id: "open-1", scope: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/localassistant")) return new Response(JSON.stringify({ code: 0, data: { online: true } }));
    if (init?.method === "POST") return new Response(JSON.stringify({ code: 0, data: { message_id: "wb-request" } }));
    return new Response(JSON.stringify({ code: 0, data: { messages: [{ message_id: "wb-reply", role: "assistant", content: ["处理完成"] }] } }));
  };
  try {
    const client = new WorkBuddyClient(config, repo);
    const request = repo.nextRequest();
    assert.ok(request);
    await processWorkBuddyRequest(repo, client, request);
    const active = repo.activeRequest();
    assert.equal(active?.agent_message_id, "wb-request");
    assert.ok(active);
    await processWorkBuddyRequest(repo, client, active);
    assert.equal(repo.listOutbox()[0]?.contact_id, "person-1");
    assert.equal(repo.listOutbox()[0]?.text, "处理完成");
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
