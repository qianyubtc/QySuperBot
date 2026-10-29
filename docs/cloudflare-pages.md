# Cloudflare Pages：介绍页与单机演示控制台

仓库包含完整服务端和纯前端演示两种运行方式。Cloudflare Pages 只发布 `dist/demo`，无需数据库、Functions、VPS、机器人 Token 或环境密钥。

## 通过 GitHub 自动发布

1. Cloudflare 控制台 → Workers & Pages → 创建应用 → Pages → 连接 Git。
2. 选择 `qianyubtc/QySuperBot`，生产分支 `main`，根目录留空。
3. 框架选择 Vite / React（或不选），构建命令 `npm run build:demo`，输出目录 `dist/demo`。
4. 构建环境设置 `NODE_VERSION=22.23.3`（或满足 `>=22.18.0` 的 Node 22 版本）。无需填写 `.env`、机器人凭据、服务器地址或数据库连接。
5. 部署后检查 `/`、`/dashboard`、`/inbox/demo-telegram-0` 和 `/accounts`，包括直接打开与刷新子页面。
6. 在 Pages 的“自定义域”添加准备好的域名；保持原 VPS 后台使用独立域名。

当前 Pages 支持纯 React/Vite 构建及 SPA 路由；仓库会在构建时输出 `_redirects`，把控制台子路径交给同一入口。官方说明：[React](https://developers.cloudflare.com/pages/framework-guides/deploy-a-react-site/)、[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)。

## 本地预览与手动上传

```sh
npm ci
npm run test:demo
npm run build:demo
node scripts/check-demo-build.mjs
npm run preview:demo
# http://127.0.0.1:5188
```

也可把 `dist/demo` 中的文件打包为 ZIP，在 Pages 的 Direct Upload 中上传。ZIP 根目录应直接包含 `index.html`、`assets`、`_headers`、`_redirects`，不要把父目录一起套进去。`vite preview` 仅供本地 QA，不自动应用 Cloudflare `_headers`；线上 Pages 会应用这些头。

## 演示边界

- 无需注册或登录。账号、成员、群、消息和权限均为程序生成的虚拟数据，各访客相互独立。
- 回复、引用、图片预览、历史翻页、群组选择、群发、规则保存、警告与成员操作均在本地模拟。图片仅存于当前浏览器；演示上传限制为 1 MiB JPG/PNG，真实后端仍是 8 MiB。
- QQ 和币安登录使用明确标识的模拟窗口，不生成真实二维码、不访问真实平台、不采集凭据。添加账号无需真实 Token。
- 页面底部提供“模拟新消息”和“一键重置”。刷新保留本地修改；清理站点数据或重置后恢复初始样例。私密模式/容量不足时保存会显示错误。
- 定时任务是本地模拟：仅页面打开时检查，关闭页面期间不会执行，重新打开后检查到期任务。不要把它用于真实运营提醒。
- 真实的自动审核、验证码、外部管理员命令、跨平台接口、服务器浏览器与长期任务调度需要自托管完整服务端。未模拟的接口明确说明不可用，不回退到真实 HTTP。
- 构建时替换 API、媒体和实时通道，生产 API 客户端不进入演示包。发布头禁止 `connect-src` 和表单提交；所有成功提示与记录都属于虚拟流程，不代表真实平台回执。

## 与真实部署隔离

`npm run build` 产出正常的 `dist/server` 与 `dist/admin`；`npm run build:demo` 仅产出 `dist/demo`。不要向 Pages 上传 `.local`、`.env`、数据库、登录状态或 VPS 备份。演示不需要配置跨域代理，不要把 `/api` 代理到真实后台。
