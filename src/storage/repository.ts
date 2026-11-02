import { randomUUID } from "node:crypto";
import type { BridgeDatabase } from "./sqlite.js";

export interface Account {
  id: string;
  bot_token: string;
  base_url: string;
  user_id: string | null;
  cursor: string;
  state: string;
  resume_at: number;
}

export interface Session {
  account_id: string;
  contact_id: string;
  context_token: string | null;
  context_generation: number;
}

export interface UserRequest {
  id: string;
  account_id: string;
  contact_id: string;
  message_id: string;
  text: string;
  state: string;
  agent_message_id: string | null;
  reply_cursor: string | null;
  next_poll_at: number;
  last_reply_at: number | null;
  last_error: string | null;
}

export interface OutboxMessage {
  id: string;
  account_id: string;
  contact_id: string;
  text: string;
  client_id: string;
  status: string;
  attempts: number;
  context_generation: number;
}

export interface WorkBuddyCredential {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  open_id: string | null;
  scope: string | null;
}

const now = () => Date.now();

export class Repository {
  constructor(readonly db: BridgeDatabase) {}

  listAccounts(): Account[] {
    return this.db.prepare("SELECT * FROM wechat_accounts ORDER BY created_at").all() as Account[];
  }

  getAccount(id: string): Account | undefined {
    return this.db.prepare("SELECT * FROM wechat_accounts WHERE id=?").get(id) as Account | undefined;
  }

  saveAccount(account: { id: string; botToken: string; baseUrl: string; userId?: string }): void {
    const t = now();
    this.db.prepare(`INSERT INTO wechat_accounts(id,bot_token,base_url,user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bot_token=excluded.bot_token,
      base_url=excluded.base_url,user_id=excluded.user_id,state='active',resume_at=0,updated_at=excluded.updated_at`)
      .run(account.id, account.botToken, account.baseUrl, account.userId ?? null, t, t);
    this.db.prepare("UPDATE outbox_messages SET status='queued',next_attempt_at=0,updated_at=? WHERE account_id=? AND status IN ('needs_login','retry_wait')").run(t, account.id);
  }

  setAccountState(id: string, state: string): void {
    this.db.prepare("UPDATE wechat_accounts SET state=?,resume_at=0,updated_at=? WHERE id=?").run(state, now(), id);
    if (state !== "active") this.db.prepare("UPDATE outbox_messages SET status='needs_login',updated_at=? WHERE account_id=? AND status IN ('queued','retry_wait','waiting_context')").run(now(), id);
  }

  pauseAccount(id: string, durationMs: number): void {
    this.db.prepare("UPDATE wechat_accounts SET state='paused',resume_at=?,updated_at=? WHERE id=?")
      .run(now() + durationMs, now(), id);
  }

  resumeAccount(id: string): void {
    this.db.prepare("UPDATE wechat_accounts SET state='active',resume_at=0,updated_at=? WHERE id=? AND state='paused' AND resume_at<=?")
      .run(now(), id, now());
  }

  getSession(accountId: string, contactId: string): Session | undefined {
    return this.db.prepare("SELECT * FROM wechat_sessions WHERE account_id=? AND contact_id=?").get(accountId, contactId) as Session | undefined;
  }

  listSessions(): Session[] {
    return this.db.prepare("SELECT account_id,contact_id,context_token,context_generation FROM wechat_sessions ORDER BY last_inbound_at DESC LIMIT 50").all() as Session[];
  }

  selectAgent(accountId: string, contactId: string, targetAgent: "workbuddy"): void {
    this.db.prepare(`INSERT INTO agent_bindings(account_id,contact_id,target_agent,selected_at)
      VALUES(?,?,?,?) ON CONFLICT(account_id,contact_id) DO UPDATE SET
      target_agent=excluded.target_agent,selected_at=excluded.selected_at`)
      .run(accountId, contactId, targetAgent, now());
  }

  getSelectedAgent(accountId: string, contactId: string): string | undefined {
    return (this.db.prepare("SELECT target_agent FROM agent_bindings WHERE account_id=? AND contact_id=?")
      .get(accountId, contactId) as { target_agent: string } | undefined)?.target_agent;
  }

  recordInbound(accountId: string, contactId: string, messageId: string, text: string, contextToken?: string): boolean {
    return this.db.transaction(() => {
      const t = now();
      const exists = this.db.prepare("SELECT message_id FROM inbound_messages WHERE account_id=? AND message_id=?").get(accountId, messageId);
      if (exists) return false;
      this.touchSession(accountId, contactId, contextToken);
      this.db.prepare("INSERT INTO inbound_messages(account_id,message_id,contact_id,received_at) VALUES(?,?,?,?)")
        .run(accountId, messageId, contactId, t);
      const result = this.db.prepare(`INSERT OR IGNORE INTO user_requests
        (id,account_id,contact_id,message_id,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(randomUUID(), accountId, contactId, messageId, text, t, t);
      return result.changes > 0;
    })();
  }

  recordSessionOnly(accountId: string, contactId: string, messageId: string, contextToken?: string): boolean {
    return this.db.transaction(() => {
      const exists = this.db.prepare("SELECT message_id FROM inbound_messages WHERE account_id=? AND message_id=?").get(accountId, messageId);
      if (exists) return false;
      this.touchSession(accountId, contactId, contextToken);
      this.db.prepare("INSERT INTO inbound_messages(account_id,message_id,contact_id,received_at) VALUES(?,?,?,?)")
        .run(accountId, messageId, contactId, now());
      return true;
    })();
  }

  touchSession(accountId: string, contactId: string, contextToken?: string): void {
    const t = now();
    const freshToken = contextToken?.trim() || null;
    this.db.prepare(`INSERT INTO wechat_sessions(account_id,contact_id,context_token,context_generation,last_inbound_at)
      VALUES(?,?,?,?,?) ON CONFLICT(account_id,contact_id) DO UPDATE SET
      context_token=COALESCE(excluded.context_token,wechat_sessions.context_token),
      context_generation=wechat_sessions.context_generation+CASE WHEN excluded.context_token IS NOT NULL THEN 1 ELSE 0 END,
      last_inbound_at=excluded.last_inbound_at`)
      .run(accountId, contactId, freshToken, freshToken ? 1 : 0, t);
    if (freshToken) this.db.prepare(`UPDATE outbox_messages SET status='queued',next_attempt_at=0,updated_at=?
      WHERE account_id=? AND contact_id=? AND status='waiting_context'`).run(t, accountId, contactId);
  }

  saveCursor(accountId: string, cursor: string): void {
    if (cursor) this.db.prepare("UPDATE wechat_accounts SET cursor=?,updated_at=? WHERE id=?").run(cursor, now(), accountId);
  }

  nextRequest(): UserRequest | undefined {
    return this.db.prepare(`SELECT * FROM user_requests WHERE state IN ('queued','awaiting_reply')
      AND next_poll_at<=? ORDER BY created_at,id LIMIT 1`).get(now()) as UserRequest | undefined;
  }

  activeRequest(): UserRequest | undefined {
    return this.db.prepare(`SELECT * FROM user_requests WHERE state IN ('sending','awaiting_reply','uncertain')
      ORDER BY created_at,id LIMIT 1`).get() as UserRequest | undefined;
  }

  setRequestState(id: string, state: string, values: { agentMessageId?: string; replyCursor?: string; nextPollAt?: number; lastReplyAt?: number; error?: string } = {}): void {
    this.db.prepare(`UPDATE user_requests SET state=?,agent_message_id=COALESCE(?,agent_message_id),
      reply_cursor=COALESCE(?,reply_cursor),last_reply_at=COALESCE(?,last_reply_at),
      next_poll_at=?,last_error=?,updated_at=? WHERE id=?`)
      .run(state, values.agentMessageId ?? null, values.replyCursor ?? null, values.lastReplyAt ?? null,
        values.nextPollAt ?? 0, values.error ?? null, now(), id);
  }

  recoverRequests(): void {
    // A crash after submission may have reached WorkBuddy. Never submit again automatically.
    this.db.prepare("UPDATE user_requests SET state='uncertain',last_error='发送中断，需人工核实',updated_at=? WHERE state='sending'").run(now());
  }

  enqueueEvent(input: { source: string; eventId: string; accountId: string; contactId: string; text: string }): { id: string; duplicate: boolean } {
    return this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT e.id,e.account_id,e.contact_id,o.text FROM agent_events e
        JOIN outbox_messages o ON o.event_id=e.id WHERE e.source=? AND e.event_id=?`)
        .get(input.source, input.eventId) as { id: string; account_id: string; contact_id: string; text: string } | undefined;
      if (prior) {
        if (prior.account_id !== input.accountId || prior.contact_id !== input.contactId || prior.text !== input.text) {
          throw new Error("同一事件标识对应的目标或内容不一致");
        }
        return { id: prior.id, duplicate: true };
      }
      if (!this.getSession(input.accountId, input.contactId)) throw new Error("目标微信会话不存在，请先让该联系人发来一条消息");
      const t = now();
      const eventId = randomUUID();
      this.db.prepare("INSERT INTO agent_events(id,source,event_id,account_id,contact_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(eventId, input.source, input.eventId, input.accountId, input.contactId, t);
      this.insertOutbox({ eventId, accountId: input.accountId, contactId: input.contactId, text: input.text });
      return { id: eventId, duplicate: false };
    })();
  }

  enqueueReply(request: UserRequest, messageId: string, text: string): void {
    this.db.transaction(() => {
      const exists = this.db.prepare("SELECT id FROM outbox_messages WHERE request_id=? AND reply_id=?").get(request.id, messageId);
      if (!exists) this.insertOutbox({ requestId: request.id, replyId: messageId, accountId: request.account_id, contactId: request.contact_id, text });
    })();
  }

  private insertOutbox(input: { eventId?: string; requestId?: string; replyId?: string; accountId: string; contactId: string; text: string }): void {
    const session = this.getSession(input.accountId, input.contactId);
    if (!session) throw new Error("目标微信会话不存在");
    const t = now();
    this.db.prepare(`INSERT INTO outbox_messages
      (id,event_id,request_id,reply_id,account_id,contact_id,text,client_id,status,context_generation,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.eventId ?? null, input.requestId ?? null, input.replyId ?? null, input.accountId, input.contactId,
        input.text, randomUUID(), session.context_token ? "queued" : "waiting_context", session.context_generation, t, t);
  }

  nextOutbox(): OutboxMessage | undefined {
    return this.db.prepare(`SELECT o.* FROM outbox_messages o JOIN wechat_accounts a ON a.id=o.account_id
      WHERE o.status IN ('queued','retry_wait') AND o.next_attempt_at<=? AND a.state='active'
      AND NOT EXISTS (SELECT 1 FROM outbox_messages p WHERE p.account_id=o.account_id AND p.contact_id=o.contact_id
        AND (p.created_at<o.created_at OR (p.created_at=o.created_at AND p.rowid<o.rowid))
        AND p.status NOT IN ('accepted','cancelled'))
      ORDER BY o.created_at,o.rowid LIMIT 1`).get(now()) as OutboxMessage | undefined;
  }

  setOutboxState(id: string, status: string, error?: string, retryMs = 0): void {
    this.db.prepare(`UPDATE outbox_messages SET status=?,attempts=attempts+1,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?`)
      .run(status, error ?? null, retryMs ? now() + retryMs : 0, now(), id);
  }

  recoverOutbox(): void {
    this.db.prepare("UPDATE outbox_messages SET status='uncertain',last_error='发送中断，需人工核实',updated_at=? WHERE status='sending'").run(now());
  }

  resolveOutbox(id: string, status: "queued" | "accepted"): void {
    const result = this.db.prepare("UPDATE outbox_messages SET status=?,last_error=NULL,next_attempt_at=0,updated_at=? WHERE id=? AND status='uncertain'")
      .run(status, now(), id);
    if (!result.changes) throw new Error("只允许核实状态为 uncertain 的待发消息");
  }

  resolveRequest(id: string, state: "queued" | "complete"): void {
    const result = this.db.prepare("UPDATE user_requests SET state=?,last_error=NULL,next_poll_at=0,updated_at=? WHERE id=? AND state='uncertain'")
      .run(state, now(), id);
    if (!result.changes) throw new Error("只允许核实状态为 uncertain 的 WorkBuddy 请求");
  }

  listOutbox(): OutboxMessage[] {
    return this.db.prepare("SELECT * FROM outbox_messages ORDER BY created_at DESC LIMIT 50").all() as OutboxMessage[];
  }

  listRequests(): UserRequest[] {
    return this.db.prepare("SELECT * FROM user_requests ORDER BY created_at DESC LIMIT 50").all() as UserRequest[];
  }

  getCredential(): WorkBuddyCredential | undefined {
    return this.db.prepare("SELECT * FROM workbuddy_credentials WHERE id='default'").get() as WorkBuddyCredential | undefined;
  }

  saveCredential(credential: WorkBuddyCredential): void {
    this.db.prepare(`INSERT INTO workbuddy_credentials(id,access_token,refresh_token,expires_at,open_id,scope,updated_at)
      VALUES('default',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,open_id=excluded.open_id,
      scope=excluded.scope,updated_at=excluded.updated_at`).run(credential.access_token, credential.refresh_token,
        credential.expires_at, credential.open_id, credential.scope, now());
  }

  saveOAuthState(state: string): void {
    this.db.prepare("INSERT INTO oauth_states(state,created_at) VALUES(?,?)").run(state, now());
  }

  consumeOAuthState(state: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT created_at FROM oauth_states WHERE state=?").get(state) as { created_at: number } | undefined;
      this.db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
      return !!row && now() - row.created_at < 10 * 60_000;
    })();
  }
}
