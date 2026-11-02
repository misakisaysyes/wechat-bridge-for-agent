# wechat-bridge-for-agent

把微信 ClawBot 会话接入本机 WorkBuddy。Stage One 支持微信文字请求、WorkBuddy 回复、定时任务通过 MCP 工具主动推送，以及待发消息持久恢复。Codex 和媒体能力属于 Stage Two，范围见 [plan.md](plan.md)。

## 准备

需要 Node.js 24 和本机运行的 WorkBuddy。微信请求转发给 WorkBuddy 依赖 [WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)，需要可申请 `user.localassistant.readable` 与 `user.localassistant.invokable` 的开发者应用及 OAuth 回调地址。开放平台对个人开发者的应用类型有限制，实际可用权限需在账号中确认。将 [.env.example](.env.example) 复制成 `.env` 并填写应用标识与密钥。`.env` 和 `data/` 已被 Git 忽略。

```bash
npm ci
npm run build
npm start -- init
```

在一个终端启动常驻服务：

```bash
npm start -- daemon
```

在另一终端分别完成绑定和授权：

```bash
npm start -- wechat-login
npm start -- workbuddy-login
npm start -- status
```

`wechat-login` 显示二维码。用测试微信扫码后，先向微信 ClawBot 发一条消息，以建立联系人会话并获取发送所需的会话凭证。若返回“已绑定”，应先核对现有 WorkBuddy 直连与新桥接服务的切换方式，避免在未确认的情况下改动现有绑定。

`workbuddy-login` 在本机 `WORKBUDDY_REDIRECT_URI` 上等待授权回调。若开发者应用只能登记非本机地址，可改用 `workbuddy-auth-url`，完成浏览器授权后运行 `workbuddy-exchange` 并在终端粘贴完整回调地址。密钥和访问凭证只保存在本机，不通过命令参数传入。

## 微信请求

用户向微信 ClawBot 发送普通文字，桥接服务默认转给 WorkBuddy。发送 `/workbuddy` 可明确选择 WorkBuddy；发送 `/workbuddy 具体请求` 可同时选择并提交请求。回复按原请求的微信账号与联系人返回。Stage One 只处理扫码绑定该账号的微信联系人。

WorkBuddy 的消息历史接口按消息标识返回后续消息，但没有公开的请求归属字段。桥接服务因此对同一个 WorkBuddy 授权用户串行提交请求，收到助理回复后再处理下一条。若用户同时直接在 WorkBuddy 发消息，仍需在真实联调中验证回复归属。

## 主动推送与定时任务

先运行 `npm run build`，再生成供本机 WorkBuddy 使用的连接器包：

```bash
npm start -- connector-generate
```

生成位置为 `data/workbuddy-connector/`，其中有 `connector-meta.json`、`mcp.json`、图标和工具说明。WorkBuddy 客户端支持[自定义连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)，可在「专家·技能·连接器」的连接器页面接入本机 MCP 服务；本机自定义连接器不依赖上面的 Open API 应用。`mcp.json` 使用当前 Node.js 可执行文件、项目绝对路径和本机数据目录，因此移动项目或更换 Node.js 后需要重新生成。

连接后可调用 `list_wechat_sessions` 查看可用目标。创建[本地定时任务](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide)时，在任务编辑窗口的「模型、专家、技能、连接器」处添加本连接器，在任务说明中写明目标微信账号标识和联系人标识，并要求任务完成后调用 `push_to_wechat`。本机 stdio 连接器不能供云端定时任务使用。每次计划执行需要稳定的 `event_id`，重试同一次执行必须复用它。例如：

```text
任务完成后调用 push_to_wechat，把结果发送到：
account_id = <status 中的账号标识>
contact_id = <status 中的联系人标识>
event_id = <任务标识>:<本次计划执行时间>
text = 本次任务结果
```

MCP 工具返回“已保存”表示结果已进入本地待发队列；微信投递状态可用 `npm start -- status` 查看。只有在实际 WorkBuddy 定时任务中验证了工具自动调用和微信收到结果，才算通过 Stage One 的主动推送验收。若 WorkBuddy 的定时任务环境不能调用本地连接器，需要另建自动上报路径。

也可用本地命令检查事件入队：

```bash
npm start -- push task-2026-11-03 <账号标识> <联系人标识> "任务已完成"
```

## 故障恢复

微信返回会话凭证失效时，内容保持待发，等同一账号与联系人的新消息更新凭证后再尝试。微信返回账号会话暂时受限时暂停一小时后自动恢复；登录凭据失效时重新运行 `wechat-login`。WorkBuddy 授权失效时，重新运行 `workbuddy-login`。数据库持久保存请求、事件和待发消息，服务重启后继续处理。

发送超时或进程在发送中退出时，结果可能已经被对端接受。此类消息标为 `uncertain`，不会自动重发。核实后使用 `resolve-outbox <消息ID> accepted` 或 `resolve-outbox <消息ID> retry`；WorkBuddy 请求使用 `resolve-request <请求ID> complete|retry`。选择 `retry` 前需确认对端未收到，否则可能重复。

## 本地验证

```bash
npm run typecheck
npm test
npm run build
```

测试使用模拟接口验证入站去重、会话归属、事件去重、凭证恢复、重启保留和请求格式。真实微信、WorkBuddy 授权和定时任务仍需实际账号联调。
