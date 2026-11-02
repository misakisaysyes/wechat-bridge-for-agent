import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataDir = fileURLToPath(new URL("../data/", import.meta.url));

export interface BridgeConfig {
  dataDir: string;
  databasePath: string;
  socketPath: string;
  workbuddyClientId?: string;
  workbuddyClientSecret?: string;
  workbuddyRedirectUri: string;
  ilinkApiBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const configuredDataDir = env.WECHAT_BRIDGE_DATA_DIR?.trim();
  const dataDir = configuredDataDir ? resolve(configuredDataDir) : defaultDataDir;

  return {
    dataDir,
    databasePath: join(dataDir, "bridge.sqlite"),
    socketPath: process.platform === "win32" ? "\\\\.\\pipe\\wechat-bridge-for-agent" : join(dataDir, "bridge.sock"),
    workbuddyClientId: env.WORKBUDDY_CLIENT_ID?.trim(),
    workbuddyClientSecret: env.WORKBUDDY_CLIENT_SECRET?.trim(),
    workbuddyRedirectUri: env.WORKBUDDY_REDIRECT_URI?.trim() || "http://127.0.0.1:8765/callback",
    ilinkApiBaseUrl: env.ILINK_API_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com",
  };
}
