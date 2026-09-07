# 银子AI视频工作流后端

Express + SQLite 本地服务，负责工作流状态、审批、资产、模型适配、费用账本、旁白和最终剪辑。完整产品说明见仓库根目录 [README](../README.md)。

开发运行要求 Node.js 22 或更新版本：

```powershell
npm install
npm start
```

默认仅监听本机回环地址。配置和数据在开发模式下位于本目录的 `configs/`、`data/`；桌面发行版位于 `%APPDATA%\银子AI视频工作流\backend`。不要把真实 API Key、开发数据库、生成素材或日志提交到仓库和发行包。
