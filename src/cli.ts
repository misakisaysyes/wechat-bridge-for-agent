import { loadConfig } from "./config.js";
import { openDatabase } from "./storage/sqlite.js";

const command = process.argv[2] ?? "help";

switch (command) {
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(
      "wechat-bridge-for-agent\n\n" +
        "可用命令:\n" +
        "  init   初始化本地数据库\n" +
        "  help   显示帮助\n\n" +
        "微信和 Agent 通信将在 Stage One 开始实现。\n",
    );
    break;

  case "init": {
    const config = loadConfig();
    const database = openDatabase(config.databasePath);
    database.close();
    process.stdout.write("已初始化本地数据库: " + config.databasePath + "\n");
    break;
  }

  default:
    process.stderr.write("未知命令: " + command + "\n");
    process.exitCode = 2;
}
