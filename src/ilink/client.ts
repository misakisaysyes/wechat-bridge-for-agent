import { randomBytes, randomUUID } from "node:crypto";

export interface IlinkMessage {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string } }[];
}

interface IlinkResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export class IlinkError extends Error {
  constructor(readonly kind: "context" | "login" | "pause" | "remote" | "network" | "uncertain", message: string) {
    super(message);
  }
}

const fixedBaseUrl = "https://ilinkai.weixin.qq.com";
const version = "0.1.0";
const clientVersion = 1 << 8;

function apiUrl(baseUrl: string, path: string): URL {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.protocol !== "https:") throw new Error("iLink API 地址必须使用 HTTPS");
  return url;
}

function headers(token?: string, qrStatus = false): Record<string, string> {
  const result: Record<string, string> = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(clientVersion),
  };
  if (!qrStatus) {
    result["Content-Type"] = "application/json";
    result.AuthorizationType = "ilink_bot_token";
    result["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64");
    if (token) result.Authorization = `Bearer ${token}`;
  }
  return result;
}

async function jsonFetch<T>(url: URL, init: RequestInit, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

function check(result: IlinkResponse): void {
  const code = result.ret && result.ret !== 0 ? result.ret : result.errcode && result.errcode !== 0 ? result.errcode : 0;
  if (code === 0) return;
  if (code === -2) throw new IlinkError("context", "微信会话凭证失效");
  if (code === -14) throw new IlinkError("pause", "微信账号会话暂时受限 (-14)");
  if (code === 401 || code === 403) throw new IlinkError("login", `微信账号登录失效 (${code})`);
  throw new IlinkError("remote", `微信接口错误 (${code}): ${result.errmsg ?? ""}`);
}

export class IlinkClient {
  constructor(readonly baseUrl: string = fixedBaseUrl) {}

  async createQrCode(localTokens: string[]): Promise<{ qrcode: string; qrcode_img_content: string }> {
    return jsonFetch(apiUrl(this.baseUrl, "/ilink/bot/get_bot_qrcode?bot_type=3"), {
      method: "POST", headers: headers(), body: JSON.stringify({ local_token_list: localTokens.slice(-10).reverse() }),
    }, 15_000);
  }

  async qrStatus(qrcode: string, baseUrl = this.baseUrl, verifyCode?: string): Promise<{
    status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string;
  }> {
    const url = apiUrl(baseUrl, "/ilink/bot/get_qrcode_status");
    url.searchParams.set("qrcode", qrcode);
    if (verifyCode) url.searchParams.set("verify_code", verifyCode);
    return jsonFetch(url, { headers: headers(undefined, true) }, 40_000);
  }

  async getUpdates(account: { base_url: string; bot_token: string; cursor: string }, signal?: AbortSignal): Promise<{
    msgs?: IlinkMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number;
  }> {
    try {
      const response = await fetch(apiUrl(account.base_url, "/ilink/bot/getupdates"), {
        method: "POST", headers: headers(account.bot_token),
        body: JSON.stringify({ get_updates_buf: account.cursor, base_info: { channel_version: version, bot_agent: "WeChatBridgeForAgent/0.1.0" } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      });
      if (response.status === 401 || response.status === 403) throw new IlinkError("login", `HTTP ${response.status}`);
      if (!response.ok) throw new IlinkError("network", `HTTP ${response.status}`);
      const data = await response.json() as IlinkResponse & { msgs?: IlinkMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
      check(data);
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof IlinkError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") return { msgs: [] };
      throw new IlinkError("network", String(error));
    }
  }

  async sendText(account: { base_url: string; bot_token: string }, contactId: string, contextToken: string, text: string, clientId: string = randomUUID()): Promise<void> {
    let response: Response;
    try {
      response = await fetch(apiUrl(account.base_url, "/ilink/bot/sendmessage"), {
        method: "POST", headers: headers(account.bot_token), signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          msg: { from_user_id: "", to_user_id: contactId, client_id: clientId,
            message_type: 2, message_state: 2, context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }] },
          base_info: { channel_version: version, bot_agent: "WeChatBridgeForAgent/0.1.0" },
        }),
      });
    } catch (error) {
      throw new IlinkError("uncertain", `微信发送结果不确定: ${String(error)}`);
    }
    if (response.status === 401 || response.status === 403) throw new IlinkError("login", `HTTP ${response.status}`);
    if (!response.ok) throw new IlinkError("remote", `HTTP ${response.status}`);
    let data: IlinkResponse;
    try { data = await response.json() as IlinkResponse; }
    catch { throw new IlinkError("uncertain", "微信发送响应无法解析"); }
    if (typeof data.ret !== "number") throw new IlinkError("uncertain", "微信发送响应缺少结果码");
    check(data);
  }
}
