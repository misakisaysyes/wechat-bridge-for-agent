import type { BridgeConfig } from "../config.js";
import { Repository, type WorkBuddyCredential } from "../storage/repository.js";

export class WorkBuddyError extends Error {
  constructor(readonly kind: "auth" | "network" | "remote" | "uncertain", message: string) { super(message); }
}

export interface WorkBuddyMessage {
  message_id: string;
  role: string;
  content: unknown[];
  msg_type?: string;
  metadata?: Record<string, unknown>;
}

const origin = "https://www.workbuddy.cn";

export class WorkBuddyClient {
  constructor(readonly config: BridgeConfig, readonly repo: Repository) {}

  authorizationUrl(state: string): string {
    if (!this.config.workbuddyClientId) throw new Error("缺少 WORKBUDDY_CLIENT_ID");
    const url = new URL("/openapi/v2/authorize", origin);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.workbuddyClientId);
    url.searchParams.set("redirect_uri", this.config.workbuddyRedirectUri);
    url.searchParams.set("scope", "user.localassistant.readable user.localassistant.invokable");
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async token(body: URLSearchParams): Promise<WorkBuddyCredential> {
    if (!this.config.workbuddyClientId || !this.config.workbuddyClientSecret) throw new WorkBuddyError("auth", "缺少 WorkBuddy 开发者应用配置");
    body.set("client_id", this.config.workbuddyClientId);
    body.set("client_secret", this.config.workbuddyClientSecret);
    let response: Response;
    try {
      response = await fetch(new URL("/openapi/v2/token", origin), {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body, signal: AbortSignal.timeout(15_000),
      });
    } catch (error) { throw new WorkBuddyError("network", String(error)); }
    if (!response.ok) throw new WorkBuddyError("auth", `WorkBuddy 授权失败: HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") {
      throw new WorkBuddyError("auth", "WorkBuddy 未返回完整凭证");
    }
    const credential: WorkBuddyCredential = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      open_id: typeof data.open_id === "string" ? data.open_id : null,
      scope: typeof data.scope === "string" ? data.scope : null,
    };
    this.repo.saveCredential(credential);
    return credential;
  }

  async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.config.workbuddyRedirectUri });
    await this.token(body);
  }

  private async accessToken(): Promise<string> {
    const credential = this.repo.getCredential();
    if (!credential) throw new WorkBuddyError("auth", "WorkBuddy 尚未授权");
    if (credential.expires_at > Date.now() + 60_000) return credential.access_token;
    const refreshed = await this.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh_token }));
    return refreshed.access_token;
  }

  private async api<T>(path: string, method: "GET" | "POST", body?: unknown, send = false): Promise<T> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(new URL(path, origin), {
        method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
      });
    } catch (error) { throw new WorkBuddyError(send ? "uncertain" : "network", String(error)); }
    if (response.status === 401 || response.status === 403) throw new WorkBuddyError("auth", `WorkBuddy 授权已失效: HTTP ${response.status}`);
    if (!response.ok) throw new WorkBuddyError(send ? "uncertain" : "remote", `WorkBuddy HTTP ${response.status}`);
    let result: { code?: number; msg?: string; data?: T };
    try { result = await response.json() as typeof result; }
    catch { throw new WorkBuddyError(send ? "uncertain" : "remote", "WorkBuddy 响应无法解析"); }
    if (result.code !== 0 || result.data === undefined) throw new WorkBuddyError("remote", `WorkBuddy 接口错误: ${result.code ?? "未知"} ${result.msg ?? ""}`);
    return result.data;
  }

  async isOnline(): Promise<boolean> {
    const data = await this.api<{ online: boolean }>("/openapi/v2/localassistant", "GET");
    return data.online === true;
  }

  async sendText(text: string): Promise<string> {
    const data = await this.api<{ message_id: string }>("/openapi/v2/localassistant/message", "POST", { content: text, msg_type: "text" }, true);
    if (!data.message_id) throw new WorkBuddyError("uncertain", "WorkBuddy 发送响应缺少消息标识");
    return data.message_id;
  }

  async messagesAfter(messageId: string): Promise<WorkBuddyMessage[]> {
    const url = new URL("/openapi/v2/localassistant/message", origin);
    url.searchParams.set("message_id", messageId);
    const data = await this.api<{ messages: WorkBuddyMessage[] }>(url.pathname + url.search, "GET");
    if (!Array.isArray(data.messages)) throw new WorkBuddyError("remote", "WorkBuddy 消息历史格式错误");
    return data.messages;
  }
}
