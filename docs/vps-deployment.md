# VPS 部署与远程币安桥接

正式拓扑为：管理浏览器通过 HTTPS 访问 VPS；运行 Chrome 的 Linux 电脑主动通过 WSS 连接同一 VPS。Chrome 所在电脑不需要公网 IP 或开放入站端口，Mac 开发机无需持续在线。

本指南使用已有 Node.js 22.18+、PostgreSQL 16+、systemd 与 Caddy 的 Linux VPS。若服务器已运行其他项目，保留现有服务，只添加 Superbot 的系统账号、数据库、服务和域名配置。应用默认绑定 `127.0.0.1:3000`，公网入口为 Caddy 的 80/443。

Node.js 运行时单独安装到 `/opt/qianyusuperbot/runtime`，不替换服务器已有的 Node。安装前从 Node.js 官方发布目录核对平台和 SHA-256 校验和；安装、检查与构建时将此目录的 `bin` 放在当前命令的 `PATH` 最前面。

## 初始化一次

在准备发布的源码目录生成配置，域名替换为实际后台域名：

```sh
node scripts/init-production.mjs bot.example.com
```

此命令创建权限为 0600 的 `.env.production`，生成数据库密码、初始化令牌和加密密钥；不输出密钥、不覆盖已有配置。之后的每次更新都沿用同一份配置。新库需创建 `qianyusuperbot` PostgreSQL 登录角色及同名数据库，密码与 `DATABASE_URL` 匹配，数据库归该角色所有。不得将这个账号用于服务器上其他项目。

1. 创建独立的 `qianyusuperbot` 系统账号，把发布版本放到 `/opt/qianyusuperbot/releases/<版本>/`，将 `/opt/qianyusuperbot/current` 链接到当前版本。代码与依赖由部署账号构建后设为 root 所有，服务账号只读取代码。
2. 在版本目录执行 `npm ci`、`npm run check`、`npm run build`，再执行 `npm prune --omit=dev`。先验证新版本，再切换 `current`。
3. 将配置安装为 `/etc/qianyusuperbot.env`，所有者 root、权限 0600。将 `deploy/qianyusuperbot.service` 安装到 `/etc/systemd/system/`，确认 `ExecStart` 使用的 Node 版本满足要求。
4. 执行 `systemctl daemon-reload` 与 `systemctl enable --now qianyusuperbot`，检查 `http://127.0.0.1:3000/api/v1/health`。返回的 `storage` 应为 `postgres`，应用数据目录由 systemd 持久保存在 `/var/lib/qianyusuperbot`。
5. 将后台域名的 DNS 指向 VPS。使用 `deploy/Caddyfile.example` 添加该域名的独立站点，先备份现有配置，运行 `caddy validate` 后平滑重载。若已有其他站点，不要覆盖整个 Caddyfile。Caddy 自动处理有效证书、WebSocket Upgrade 和 `text/event-stream` 的实时转发。
6. 通过 HTTPS 验证首页、健康接口、管理员初始化与登录、实时消息 SSE、币安 WebSocket 挑战握手。首次管理员初始化需要 `.env.production` 中的 `ADMIN_SETUP_TOKEN`。

新生产数据库不会自动继承本地测试管理员、测试数据或配对密钥。若需要迁移本地数据，需单独停机导出并迁移，不能直接把 PGlite 数据目录交给 PostgreSQL。默认创建新的生产管理员与平台连接。

## 配对 Linux Chrome

在 VPS 的后台添加币安连接，授权指定群，复制该后台新生成的配对 JSON。`server_url` 应为实际后台域名对应的地址：

```text
wss://bot.example.com/api/v1/connectors/binance/socket
```

将完整 JSON 粘贴进 Linux Chrome 的币安桥接扩展，保存并连接。保持该 Chrome 配置和币安聊天标签打开。无需安装 Tailscale 或给 Chrome 电脑配置公网 IP。

验收顺序为：外网 WSS 握手、扩展认证、币安身份和群资料核对、初次历史导入、后续新消息进入网页。实际发送及引用回复仍需选定测试群和测试文案，再检查平台真实回执。

## 更新与备份

### 同机 QQ 桥接

QQ 普通群使用独立的 NapCat / QQ 客户端进程。兼容版本参考：NapCat `v4.18.41` 与 Linux QQ `3.2.34-53644`，独立服务为 `qianyusuperbot-qq.service`，模板见 `deploy/qianyusuperbot-qq.service`。

- 程序位于 `/opt/qianyusuperbot-qq/current`，登录状态及配置位于 `/var/lib/qianyusuperbot-qq`，由专用普通用户 `qsb-qq` 运行。
- NapCat HTTP API 绑定 `127.0.0.1:3004`，后台连接地址为 `http://127.0.0.1:3004`。后台环境只设置 `QQ_LOCAL_PORT=3004`，不启用全局私网连接。
- NapCat WebUI 绑定 `127.0.0.1:6099`，通过 SSH 转发查看扫码页面；不需要新增公网入口或域名。
- HTTP API Token、HTTP 客户端上报 Token、WebUI Token 分开配置。HTTP 客户端使用创建 QQ 账号时生成的上报地址和 `qq_webhook_token`，消息格式选 `array`。
- 服务启动和扫码入口可用不代表 QQ 已登录。扫码确认后，在后台点 QQ 账号的“连接 / 刷新”，核对 QQ 身份、群列表及角色，再验证真实群消息同步和回复。

QQ 登录状态可能失效。平台要求手机确认或恢复账号时，请在后台重新扫码，再核对连接身份、群列表与权限。

### 后台更新

每次发布保留旧版本和生产配置。在新版本目录完成依赖安装、检查与构建，然后切换 `current` 并重启 `qianyusuperbot`。重连不会自动重发结果未知的任务；数据库迁移在启动时运行，回退代码前需确认新旧数据库结构兼容。

定期用 `pg_dump` 备份 `qianyusuperbot` 数据库，同时安全备份 `/etc/qianyusuperbot.env`。数据库中的平台凭据只有配套 `ENCRYPTION_KEY` 才能解密。备份 Caddy 的证书数据与站点配置；不要把配置、数据库或密钥提交到 Git 或打进扩展 ZIP。

参考：[Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理与实时流](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

