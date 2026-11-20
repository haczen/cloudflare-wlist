<a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA-FFB003?style=flat-square" alt="LINUX DO 社区" /></a>

# WList — 跑在 Cloudflare 上的多网盘聚合存储中心

<img src="public/favicon.svg" width="86" align="right" alt="WList Logo：毛茸茸小狗坐在云上听音乐" />

[![CI](https://github.com/haczen/cloudflare-wlist/actions/workflows/ci.yml/badge.svg)](https://github.com/haczen/cloudflare-wlist/actions/workflows/ci.yml)
[![Deploy](https://github.com/haczen/cloudflare-wlist/actions/workflows/deploy.yml/badge.svg)](https://github.com/haczen/cloudflare-wlist/actions/workflows/deploy.yml)
[![Release](https://github.com/haczen/cloudflare-wlist/actions/workflows/release.yml/badge.svg)](https://github.com/haczen/cloudflare-wlist/releases)
[![Latest Release](https://img.shields.io/github/v/release/haczen/cloudflare-wlist?display_name=tag&sort=semver)](https://github.com/haczen/cloudflare-wlist/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F6821f?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

一个开源、自托管的私有云盘门户：把散落在各家对象存储和网盘里的文件，聚合成**一棵统一的目录树**，配上用户体系、权限控制、全类型在线预览、直链分享、跨桶聚合上传、免登录传输盘和 **AI 守盘助手**。全部运行在 Cloudflare Workers 免费额度内，**无需服务器**。

```
 ┌────────────────────────── WList ──────────────────────────┐
 │                                                            │
 │   📂 公开图库 🌐        📂 私人备份        📦 传输盘 🌐     │
 │      📂 壁纸                📂 备份集                        │
 │                                                            │
 │   （用户只看到目录树 —— 底层挂在哪个盘完全透明）              │
 └──────────┬───────────────┬───────────────┬─────────────────┘
            │               │               │
      Cloudflare R2    Backblaze B2     OneDrive / Google Drive
        S3/OSS/COS      WebDAV 任意      百度网盘 / 阿里云盘 / Telegram
```

## 目录

- [特色亮点](#特色亮点) · [特性](#特性)
- [快速部署（约 5 分钟）](#快速部署约-5-分钟) · [持续部署](#持续部署可选) · [可选集成](#github-登录可选)（GitHub 登录 / Telegram / S3 配置）
- [守盘助手（AI 看板娘）](#守盘助手ai-看板娘)
- [使用模型](#使用模型) · [常见问题](#常见问题-faq) · [技术栈](#技术栈)
- [更新日志](#更新日志) · [Star History](#star-history)

## 特色亮点

- **$0 运行成本**：Workers（每日 10 万请求）+ D1（SQLite）+ 静态资源托管，全在免费额度内；push 到 main 即自动部署（GitHub Actions）
- **单个大文件不受单盘容量/大小限制**：跨桶切片聚合（聚合盘），1TB 的文件也能平摊到 N 个免费桶里
- **传输盘 = 临时文件中转站**：不登录、拖进去、拿链接、7 天自动清理 —— 跨设备传大文件的零成本方案
- **Telegram 也可以是你的云盘**：Bot 收文件转存、上传完成通知、TG 收藏夹当聚合盘成员
- **桶对用户完全隐形**：授权的最小单位是「虚拟目录」，而不是某个存储后端
- **全类型在线预览**：点开任何文件都进预览——未知扩展名自动做内容嗅探（文本直接渲染、二进制给下载引导）；ZIP 只拉尾部目录秒开；传输盘视频支持拖进度条（HTTP Range）
- **守盘助手**：右下角的 Live2D 看板娘（5 款官方形象任选）会眨眼、自己挑动作玩（跳舞 / 摇头 / 被捏脸…外加程序化小跳/摇摆/弹跳）、视线全程跟随鼠标；接入任意 OpenAI 兼容模型后可对话，支持**用户接入自己的 Key 无限畅聊**
- 三套主题（白 / 黑 / 暖）**圆形扩散转场**切换、全站色彩统一走主题令牌、站点 Logo（坐云听歌的小狗）—— 开箱即是成品站

## 特性

**聚合多种存储后端**（统一一套 API，接新盘只要填配置）
- S3 兼容：AWS S3 / Cloudflare R2 / Backblaze B2 / 阿里 OSS / 腾讯 COS / MinIO
- WebDAV：坚果云、TeraCloud、任意自建
- 网盘驱动：OneDrive（含世纪互联）、Google Drive、百度网盘、阿里云盘
- Telegram：Bot Token + Chat ID 即成一块盘（文件以消息形式存进收藏夹，≤20MB/条）

**虚拟目录树**（桶对用户完全隐形）
- 管理员侧边栏「目录」旁的 ＋ 按钮直接新建顶层目录，也可在任意目录下建子目录
- 支持「普通盘」（整个目录落在一个桶）与「聚合盘」（见下）两种模式，可随时互转
- 目录可标记「公开」，访客无需登录即可浏览
- 用户分配到的是**目录**而非桶，浏览 / 下载 / 上传三项权限独立控制

**聚合盘 —— 大文件跨桶切片**（单文件大小不再受限于任何一块盘）
- 上传时自动切片、轮询平分到全部成员桶；分片藏在 `.wlistpool/` 隐藏子树，正常浏览不可见
- 下载时 Worker 顺序拉取分片拼回完整原件，对用户就是普通文件；**支持 HTTP Range**（传输盘视频可拖进度条）
- 分片大小自适应（默认 256MB，保证单文件 ≤40 片 —— Workers 免费版单请求 50 子请求上限）
- 每片走预签名直传（multipart），失败自动回退代理转发；上传中断刷新页面可续传
- 聚合盘根目录可直接在线新建文本文件（≤2MB 服务端直存，编辑器保存即入盘）

**传输盘 —— 免登录公共中转**
- 聚合盘 + 公开 + 允许访客上传 = 传输盘：**不登录即可上传、下载**；删除需登录且**仅限自己上传的文件**（游客不能删任何人的文件）
- 拖拽到页面任意位置 / Ctrl+V 粘贴 / 断网刷新续传
- 文件保留 7 天，到期自动清理（访问目录时惰性触发 + 每日 Cron 兜底），清理完自动 Telegram 通知
- 私有聚合盘不参与清理，是永久存储

**Telegram 集成**
- 把文件直接发给 Bot（≤20MB）→ 自动转存进传输盘
- `/list` 列出传输盘文件、`/link` 直接取下载直链
- 上传完成推送、7 天清理结果推送（仅白名单 Chat 可用）
- TG 可作为聚合盘成员：上传时勾选「云桶 + Telegram」，TG 分片 15MB 走收藏夹（**管理员专属选项**，单文件 >600MB 自动降级纯云桶）

**上传引擎**
- 多任务并发（3 文件同时传），任务面板统一管理（暂停 / 取消 / 重试）
- 分片断点续传 + 刷新/断网恢复（localStorage + IndexedDB 持久化）
- 传过的内容自动校验，重传同一文件给出明确提示而非静默忽略
- 支持 0 字节空文件

**多用户体系**
- 账号密码（PBKDF2）+ GitHub OAuth 登录
- 个人资料：昵称、个性签名、头像、自助改密
- 管理面板：用户增删、禁用、角色、目录授权，全量审计日志

**文件操作与预览**
- 重命名、移动（虚拟目录树视角）、复制直链、批量删除 / 下载、离线下载（URL 转存）
- 在线新建 / 编辑文本文件（Markdown、代码、JSON…）
- 预览全家桶：图片（网格缩略图）、视频（时长+拖进度）、音频、PDF、Markdown、代码高亮、Office、ZIP 目录（只拉尾部秒开）、**未知类型内容嗅探**（前 64KB 判定文本/二进制）
- 下载 / 缩略图 / 媒体预览全部走**签名直链**（客户端直连存储源站，不经 Worker 中转流量）

**分享**
- 任意文件 / 目录生成分享链接，支持访问密码、有效期、自定义令牌、二维码
- WebDAV 服务端：把整个门户挂载为系统磁盘（`/dav/<目录>`）

## 快速部署（约 5 分钟）

```bash
git clone https://github.com/haczen/cloudflare-wlist.git
cd cloudflare-wlist
npm install
cp wrangler.jsonc.example wrangler.jsonc   # 改里面的管理员密码
npx wrangler d1 create wlist               # 把返回的 database_id 填进 wrangler.jsonc
npm run deploy
```

部署成功后绑定你自己的域名（或先用 `*.workers.dev`），打开站点用 `wrangler.jsonc` 里设置的管理员账号登录，添加第一个存储桶，创建第一个目录 —— 完事。

> 首次登录会用环境变量里的管理员账号自动建号；数据表在首次访问时自动建（`migrations/schema.sql` 仅作参考，无需手动执行）。之后可在「个人资料」里改密码，或在管理面板创建更多用户。

### 持续部署（可选）

fork 后在仓库 Settings → Secrets 配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `ADMIN_PASSWORD`，变量 `DATABASE_ID`，push 到 main 即自动部署（`.github/workflows/deploy.yml`）。`wrangler.jsonc` 已 gitignore，CI 从 example 模板生成。

**CI / Release**：所有分支 push / PR 自动跑 typecheck + build（`ci.yml`）；打 `v*` 标签（如 `git tag v1.3.0 && git push --tags`）自动构建并发布 GitHub Release，附自动生成的完整变更说明（`release.yml`）。

### GitHub 登录(可选)

1. [github.com/settings/developers](https://github.com/settings/developers) 新建 OAuth App，回调填 `https://你的域名/api/auth/github/callback`
2. **本地部署**（`npm run deploy`）：Client ID / Secret 填入 `wrangler.jsonc` 的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
   **CI 部署**（推荐）：改为在仓库 Settings → Secrets and variables → Actions 添加 secrets `_GITHUB_CLIENT_ID` / `_GITHUB_CLIENT_SECRET`（注意 GitHub Actions 禁止 secrets 以 `GITHUB_` 开头——保留前缀，所以必须带前导下划线，CI 里会映射回正确的变量名）。
   CI 每次部署都从 example 模板重新生成 `wrangler.jsonc`，本地文件的修改不会生效，secrets 缺失时这两个 var 会被覆盖为空、GitHub 登录自动禁用
3. 重新部署后生效

### Telegram 集成（可选）

1. @BotFather 建 Bot，拿 Token；先给你的 Bot 发一条 `/start`（拿到自己的 Chat ID）
2. 后台「添加存储」选 **Telegram**，填 Bot Token 与 Chat ID
3. `wrangler.jsonc` 里设置 `TELEGRAM_WEBHOOK_SECRET` 并重新部署，Webhook 自动注册到 `/api/telegram/webhook`

之后直接给 Bot 发文件即可转存传输盘；`/list`、`/link` 随时可用。

### S3 兼容存储配置

后台「添加存储」选 **S3 兼容存储**：

| 字段 | 说明 |
|---|---|
| Endpoint | 不带桶名的服务端点，如 `https://oss-cn-heyuan.aliyuncs.com`、`https://s3.us-east-1.amazonaws.com`、`https://<accountid>.r2.cloudflarestorage.com` |
| Region | 区域 ID。**阿里云 OSS 必须填地域 ID**（如 `cn-heyuan`），填 `oss-cn-heyuan` 或保持默认会报 `SignatureDoesNotMatch` |
| Bucket / Access Key ID / Secret | 对应桶名与 AK/SK |

默认使用 **虚拟托管（Virtual-Hosted）** 访问——桶名作为子域名。AWS S3 / R2 / B2 / 阿里云 OSS / 腾讯 COS 均要求此方式；阿里云 OSS 不支持 path-style，强行使用会返回 `403 SecondLevelDomainForbidden`。

仅在 **MinIO 等未配置泛域名解析的私有存储** 场景下，勾选表单里的 **强制 Path-Style 访问**（等价于在扩展配置 JSON 里写 `{"forcePathStyle": true}`），桶名会改放入 URL 路径。

> Endpoint 无需也不应自带桶名子域名；如已写成 `https://<bucket>.oss-...`，虚拟托管会自动识别并避免重复拼接，但仍建议填裸端点。

## 使用模型

| 角色 | 看到什么 | 能和她聊天吗 |
|---|---|---|
| 访客 | 所有标记「公开」的目录；传输盘还能免登录上传 | ❌ 登录后才可以 |
| 普通用户 | 公开目录 ∪ 管理员分配给 TA 的目录（每个目录可独立开 浏览/下载/上传）；传输盘可删/重命名自己上传的文件 | ✓ 站内模型共 5 次；⚙ 里接入自己的模型即无限 |
| 管理员 | 全部目录 + 存储后端（桶）+ 聚合/TG 专属选项 + 管理面板 | ✓ 无限 |

权限判定只有一条规则：**目录是唯一的大门** —— 桶本身的配置不直接产生任何访问授权，所以「把某个目录公开 / 某个目录只给某人」都是一键操作，立即生效。

## 守盘助手（AI 看板娘）

右下角常驻一只 Live2D 看板娘：会眨眼、待机动作自动播、**每 10~22 秒自己挑个动作玩**（跳舞 / 摇头 / 被捏脸，外加程序化的跳跃 / 摇摆 / Q 弹）、**每 14~28 秒自己说一句话**、视线全程跟随鼠标；点她 = 动作 + 表情 + 台词（还有连招小惊喜），按住可以把她拖到屏幕任意位置。

**管理员接入**（管理面板 → 守盘助手 → AI 对话）：

| 字段 | 说明 |
|---|---|
| API Base URL | OpenAI 兼容端点（DeepSeek / GLM / Kimi / OpenAI / 自建 Ollama / 各类中转），漏了 `/v1` 会自动补试 |
| 模型名 | 点「可用模型」直接拉取清单，**点模型名即切换**（当前模型打勾） |
| API Key | 只存服务端 D1，浏览器全程接触不到 |
| 人设提示词 | 可改（只有管理员可见，普通用户界面不出现） |
| 测试连接 | 真发一条消息验证配置 |
| 形象 | 小滴 / 山药猫 / 小黑狗 / 小饭团（默认）/ 桃濑日和 五选一，点选即存 |

**对话规则**：

- 游客不能聊天（登录是门槛）；管理员无限畅聊
- 普通用户用站内模型共 **5 次**（聊天框下方实时显示剩余次数）
- 聊天窗口 ⚙ 里三步接入**自己的模型**（① 填 API 地址和 Key → ② 「🔍 测试并获取模型列表」验证连通 → ③ 点选模型保存）→ **无限畅聊**，Key 只存服务端
- 聊天窗口可拖动位置（标题栏）、**四条边 + 四个角自由缩放**（往哪拉往哪长），位置尺寸自动记忆

**上游兼容性**（自动处理，无需配置）：Base URL 漏 `/v1` 自动补试；上游停用 `/chat/completions`（如部分 Codex 类中转）自动降级 `/responses`（Responses API）；网络抖动自动重试。

> 模型形象来自 [Live2D](https://www.live2d.com/) 官方免费素材（见文末致谢）。

## 常见问题 FAQ

**Q：守盘助手聊天报「上游网络不通 / 上游返回 4xx」？**
看具体错误：`401` = Key 无效；`404` = 模型名或路径不对（确认以 `/v1` 结尾、模型 id 与中转一致，点「可用模型」看真名）；`403 client_not_allowed` = 该中转仅允许编程客户端（Codex / Claude Code 等），换个通用中转或官方 API；一直超时 = 上游对你所在地区/出口不稳定。管理面板「测试连接」可以一键分型诊断。

**Q：`*.workers.dev` 打不开？**
该域名在部分地区被污染，需代理访问；建议绑定自己的自定义域名。

**Q：聚合盘上传到一半断了怎么办？**
什么都不用做，刷新页面继续——分片进度持久化在浏览器里，已传的分片不会重传。

**Q：怎么升级？**
`git pull && npm install && npm run deploy`（或 CI 部署的直接 push）。数据表变更随首次访问自动迁移，D1 数据不受影响。

## 技术栈

- [React Router v7](https://reactrouter.com/)（SSR + SPA 混合）+ Tailwind CSS v4（三主题 = CSS 色板令牌覆写 + View Transitions 圆形转场）
- Cloudflare Workers + D1（SQLite）+ Workers 静态资源（`public/_headers` 缓存策略）+ Cron Trigger（7 天保留清理）
- 守盘助手：pixi.js + pixi-live2d-display（Cubism 2/4 双代按需加载）+ Canvas 2D 手绘底座（日夜调色板逐帧补间）
- 各存储后端为独立客户端模块（`app/lib/*-client.ts`），统一实现 `listObjects / getObject / putObject / multipart...` 接口，新增一种存储只需实现一个客户端并在工厂注册

```
app/
├── lib/
│   ├── s3-client.ts        # S3 兼容（R2/B2/OSS/COS/MinIO）
│   ├── webdav-client.ts    # WebDAV
│   ├── onedrive-client.ts / gdrive-client.ts / baiduyun-client.ts / alicloud-client.ts
│   ├── telegram-client.ts / telegram-bot.ts   # TG 存储盘 + Bot webhook
│   ├── client-factory.ts   # 按配置实例化客户端
│   ├── folders.ts          # 虚拟目录树 + 权限解析
│   ├── pool.ts             # 聚合盘：分片规划 / 清单 / 7 天保留清理
│   ├── upload-manager.ts   # 上传引擎：并发 / 续传 / 刷新恢复
│   ├── pet.ts              # 守盘助手配置层（形象 / AI / BYOK）
│   ├── users.ts / auth.ts / password.ts   # 用户与会话
│   └── shares.ts / audit.ts
├── routes/                 # 页面与 API（home / share / api.* / api.telegram）
└── components/
    ├── Live2DHome.tsx      # 守盘助手（模型加载 / 程序化动作 / 聊天窗）
    ├── PetStand.tsx        # Canvas 底座（坐垫 / 宠物小窝，日夜补间）
    ├── FilePreview.tsx     # 全类型预览（嗅探 / ZIP 快开 / Range）
    └── ...                 # 对话框、管理面板、上传任务面板
```

## 更新日志

见 [Releases](https://github.com/haczen/cloudflare-wlist/releases) —— 每个版本自动生成完整变更说明。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=haczen/cloudflare-wlist&type=Date)](https://star-history.com/#haczen/cloudflare-wlist&Date)

## 开源许可

MIT

## 致谢

- 看板娘形象来自 [Live2D](https://www.live2d.com/) 官方示例模型（しずく / とろろ・ひじき / ライス / ひより），依据 [Live2D 免费素材许可协议](https://www.live2d.com/eula/live2d-open-software-license-agreement.html) 使用，© Live2D Inc.
- Live2D 渲染基于 [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)（MIT）
