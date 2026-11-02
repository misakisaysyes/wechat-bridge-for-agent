import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataDir = fileURLToPath(new URL("../data/", import.meta.url));

export interface BridgeConfig {
  dataDir: string;
  databasePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const configuredDataDir = env.WECHAT_BRIDGE_DATA_DIR?.trim();
  const dataDir = configuredDataDir ? resolve(configuredDataDir) : defaultDataDir;

  return {
    dataDir,
    databasePath: join(dataDir, "bridge.sqlite"),
  };
}
