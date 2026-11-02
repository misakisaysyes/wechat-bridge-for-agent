import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import qrcode from "qrcode-terminal";
import { generateWorkBuddyConnector } from "./connector.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { IlinkClient } from "./ilink/client.js";
import { sendIpc } from "./ipc.js";
import { runMcp } from "./mcp.js";
import { Repository } from "./storage/repository.js";
import { openDatabase } from "./storage/sqlite.js";
import { WorkBuddyClient } from "./workbuddy/client.js";

if (process.argv[2] !== "mcp" && existsSync(".env")) {
  if (process.platform !== "win32") chmodSync(".env", 0o600);
  process.loadEnvFile(".env");
}

function help(): void {
  process.stdout.write(`wechat-bridge-for-agent

命令:
  init                         初始化数据库
  daemon                       启动常驻桥接服务
  wechat-login                 扫码绑定微信 ClawBot
  workbuddy-login              授权 WorkBuddy 本地助理
  workbuddy-auth-url           生成授权地址，供非本机回调使用
  workbuddy-exchange           输入回调地址并换取凭证
  connector-generate           生成 WorkBuddy 本地连接器包
  status                       查看账号、会话和消息状态
  push <事件ID> <账号ID> <联系人ID> <文字>   提交主动推送
  resolve-outbox <消息ID> <accepted|retry>   核实不确定的微信发送
  resolve-request <请求ID> <complete|retry> 核实不确定的 WorkBuddy 请求
  mcp                          启动 WorkBuddy 本地 MCP 服务
`);
}

async function wechatLogin(config: BridgeConfig, repo: Repository): Promise<void> {
  const client = new IlinkClient(config.ilinkApiBaseUrl);
  const qr = await client.createQrCode(repo.listAccounts().map((account) => account.bot_token));
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信未返回可用二维码");
  qrcode.generate(qr.qrcode_img_content, { small: true });
  process.stdout.write(`请用微信扫描二维码。备用内容: ${qr.qrcode_img_content}\n`);
  let baseUrl = config.ilinkApiBaseUrl;
  let verifyCode: string | undefined;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      let status;
      try { status = await client.qrStatus(qr.qrcode, baseUrl, verifyCode); }
      catch (error) { process.stderr.write(`二维码状态查询失败，将重试: ${String(error)}\n`); await sleep(2000); continue; }
      verifyCode = undefined;
      if (status.status === "wait" || status.status === "scaned") { await sleep(500); continue; }
      if (status.status === "need_verifycode") { verifyCode = (await input.question("请输入手机上的验证码: ")).trim(); continue; }
      if (status.status === "scaned_but_redirect" && status.redirect_host) {
        baseUrl = status.redirect_host.startsWith("https://") ? status.redirect_host : `https://${status.redirect_host}`;
        continue;
      }
      if (status.status === "confirmed") {
        if (!status.ilink_bot_id || !status.bot_token) throw new Error("微信确认登录，但未返回账号凭据");
        repo.saveAccount({ id: status.ilink_bot_id, botToken: status.bot_token, baseUrl: status.baseurl ?? baseUrl, userId: status.ilink_user_id });
        process.stdout.write(`微信账号已绑定: ${status.ilink_bot_id}\n扫码联系人: ${status.ilink_user_id ?? "未返回"}\n`);
        return;
      }
      if (status.status === "binded_redirect") { process.stdout.write("微信显示该 ClawBot 已绑定。请先确认是否需要迁移现有绑定。\n"); return; }
      if (status.status === "expired" || status.status === "verify_code_blocked") throw new Error("二维码已失效，请重新运行 wechat-login");
      throw new Error(`未知微信扫码状态: ${status.status}`);
    }
  } finally { input.close(); }
}

async function workbuddyLogin(config: BridgeConfig, repo: Repository): Promise<void> {
  if (!config.workbuddyClientId || !config.workbuddyClientSecret) throw new Error("请先配置 WORKBUDDY_CLIENT_ID 和 WORKBUDDY_CLIENT_SECRET");
  const callback = new URL(config.workbuddyRedirectUri);
  if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname)) {
    throw new Error("Stage One 的 workbuddy-login 需要本机 HTTP 回调地址，并在 WorkBuddy 开发者应用中登记该地址");
  }
  const state = randomBytes(24).toString("hex");
  repo.saveOAuthState(state);
  const client = new WorkBuddyClient(config, repo);
  let authorized = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", callback.origin);
      if (url.pathname !== callback.pathname) { response.writeHead(404).end(); return; }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!returnedState || !code || returnedState !== state || !repo.consumeOAuthState(returnedState)) {
        response.writeHead(400).end("授权回调无效");
        return;
      }
      try {
        await client.exchangeCode(code);
        authorized = true;
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("WorkBuddy 授权成功，可以关闭此页面。");
        server.close();
      } catch (error) {
        response.writeHead(500).end("WorkBuddy 授权失败，请查看终端。");
        process.stderr.write(`${String(error)}\n`);
        server.close();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(callback.port || 80), callback.hostname, () => { server.off("error", reject); resolve(); });
  });
  process.stdout.write(`请在浏览器打开以下地址并完成授权:\n${client.authorizationUrl(state)}\n`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => server.close(), 10 * 60_000);
    server.once("close", () => { clearTimeout(timer); resolve(); });
  });
  if (!authorized) throw new Error("WorkBuddy 授权未完成");
  process.stdout.write("WorkBuddy 授权已保存。\n");
}

function workbuddyAuthUrl(config: BridgeConfig, repo: Repository): void {
  const state = randomBytes(24).toString("hex");
  repo.saveOAuthState(state);
  const url = new WorkBuddyClient(config, repo).authorizationUrl(state);
  process.stdout.write(`请在浏览器打开以下地址完成授权，然后运行 workbuddy-exchange 并粘贴跳转后的完整地址:\n${url}\n`);
}

async function workbuddyExchange(config: BridgeConfig, repo: Repository): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = (await input.question("请粘贴授权跳转后的完整地址: ")).trim();
    const callback = new URL(raw);
    if (callback.origin + callback.pathname !== new URL(config.workbuddyRedirectUri).origin + new URL(config.workbuddyRedirectUri).pathname) {
      throw new Error("回调地址与 WORKBUDDY_REDIRECT_URI 不一致");
    }
    const state = callback.searchParams.get("state");
    const code = callback.searchParams.get("code");
    if (!state || !code || !repo.consumeOAuthState(state)) throw new Error("授权码或状态无效，请重新获取授权地址");
    await new WorkBuddyClient(config, repo).exchangeCode(code);
    process.stdout.write("WorkBuddy 授权已保存。\n");
  } finally { input.close(); }
}

function status(repo: Repository): void {
  const result = {
    accounts: repo.listAccounts().map(({ id, state, user_id }) => ({ id, state, user_id })),
    sessions: repo.listSessions().map(({ account_id, contact_id, context_token }) => ({ account_id, contact_id, has_context: !!context_token, target_agent: repo.getSelectedAgent(account_id, contact_id) ?? "workbuddy" })),
    requests: repo.listRequests().map(({ id, account_id, contact_id, state, last_error }) => ({ id, account_id, contact_id, state, last_error })),
    outbox: repo.listOutbox().map(({ id, account_id, contact_id, status, attempts }) => ({ id, account_id, contact_id, status, attempts })),
    workbuddyAuthorized: !!repo.getCredential(),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { help(); return; }
  if (command === "mcp") { await runMcp(); return; }
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  const repo = new Repository(database);
  try {
    switch (command) {
      case "init": process.stdout.write(`已初始化本地数据库: ${config.databasePath}\n`); break;
      case "daemon": await runDaemon(config, repo); break;
      case "wechat-login": await wechatLogin(config, repo); break;
      case "workbuddy-login": await workbuddyLogin(config, repo); break;
      case "workbuddy-auth-url": workbuddyAuthUrl(config, repo); break;
      case "workbuddy-exchange": await workbuddyExchange(config, repo); break;
      case "connector-generate": process.stdout.write(`连接器已生成: ${generateWorkBuddyConnector(config)}\n`); break;
      case "status": status(repo); break;
      case "push": {
        const [, , , eventId, accountId, contactId, ...parts] = process.argv;
        const text = parts.join(" ");
        if (!eventId || !accountId || !contactId || !text) throw new Error("用法: push <事件ID> <账号ID> <联系人ID> <文字>");
        const result = await sendIpc(config, { command: "push", source: "cli", eventId, accountId, contactId, text });
        process.stdout.write(JSON.stringify(result) + "\n");
        break;
      }
      case "resolve-outbox": {
        const id = process.argv[3];
        const action = process.argv[4];
        if (!id || !["accepted", "retry"].includes(action ?? "")) throw new Error("用法: resolve-outbox <消息ID> <accepted|retry>");
        repo.resolveOutbox(id, action === "retry" ? "queued" : "accepted");
        break;
      }
      case "resolve-request": {
        const id = process.argv[3];
        const action = process.argv[4];
        if (!id || !["complete", "retry"].includes(action ?? "")) throw new Error("用法: resolve-request <请求ID> <complete|retry>");
        repo.resolveRequest(id, action === "retry" ? "queued" : "complete");
        break;
      }
      default: throw new Error(`未知命令: ${command}`);
    }
  } finally { database.close(); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
