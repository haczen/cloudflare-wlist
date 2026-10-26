# WList — 跑在 Cloudflare 上的多网盘聚合存储中心

一个开源、自托管的私有云盘门户：把散落在各家对象存储和网盘里的文件，聚合成**一棵统一的目录树**，配上用户体系、权限控制、在线预览、直链分享和 WebDAV。全部运行在 Cloudflare Workers 免费额度内，无需服务器。

```
 ┌────────────────────────── WList ──────────────────────────┐
 │                                                            │
 │   📂 公开图库 🌐        📂 私人备份        📂 工作文档      │
 │      📂 壁纸                📂 备份集                        │
 │                                                            │
 │   （用户只看到目录树 —— 底层挂在哪个盘完全透明）              │
 └──────────┬───────────────┬───────────────┬─────────────────┘
            │               │               │
      Cloudflare R2    Backblaze B2     OneDrive / Google Drive
        S3/OSS/COS      WebDAV 任意      百度网盘 / 阿里云盘
```

## 特性

**聚合多种存储后端**（统一一套 API，接新盘只要填配置）
- S3 兼容：AWS S3 / Cloudflare R2 / Backblaze B2 / 阿里 OSS / 腾讯 COS / MinIO
- WebDAV：坚果云、TeraCloud、任意自建
- 网盘驱动：OneDrive（含世纪互联）、Google Drive、百度网盘、阿里云盘

**虚拟目录树**（桶对用户完全隐形）
- 管理员建目录时选择落在哪个桶，支持主目录 → 任意层级子目录
- 目录可标记「公开」，访客无需登录即可浏览
- 用户分配到的是**目录**而非桶，浏览 / 下载 / 上传三项权限独立控制

**多用户体系**
- 账号密码（PBKDF2）+ GitHub OAuth 登录
- 个人资料：昵称、个性签名、头像、自助改密
- 管理面板：用户增删、禁用、角色、目录授权，全量审计日志

**文件操作**
- 上传：拖拽 / 粘贴 / 分片断点续传（预签名直传优先，失败自动回退代理）
- 在线新建 / 编辑文本文件（Markdown、代码、JSON…）
- 重命名、移动、复制直链、批量删除 / 下载、离线下载（URL 转存）
- 预览：图片（网格缩略图）、视频（时长）、音频、PDF、Markdown、代码高亮、Office、ZIP 目录

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

> 首次登录会用环境变量里的管理员账号自动建号；之后可在「个人资料」里改密码，或在管理面板创建更多用户。

### GitHub 登录（可选）

1. [github.com/settings/developers](https://github.com/settings/developers) 新建 OAuth App，回调填 `https://你的域名/api/auth/github/callback`
2. Client ID / Secret 填入 `wrangler.jsonc` 的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
3. 重新 `npm run deploy`

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

| 角色 | 看到什么 |
|---|---|
| 访客 | 所有标记「公开」的目录 |
| 普通用户 | 公开目录 ∪ 管理员分配给 TA 的目录（每个目录可独立开 浏览/下载/上传）|
| 管理员 | 全部目录 + 存储后端（桶）+ 管理面板 |

权限判定只有一条规则：**目录是唯一的大门** —— 桶本身的配置不直接产生任何访问授权，所以「把某个目录公开 / 某个目录只给某人」都是一键操作，立即生效。

## 技术栈

- [React Router v7](https://reactrouter.com/)（SSR + SPA 混合）+ Tailwind CSS v4
- Cloudflare Workers + D1（SQLite）+ Workers 静态资源
- 各存储后端为独立客户端模块（`app/lib/*-client.ts`），统一实现 `listObjects / getObject / putObject / multipart...` 接口，新增一种存储只需实现一个客户端并在工厂注册

```
app/
├── lib/
│   ├── s3-client.ts        # S3 兼容（R2/B2/OSS/COS/MinIO）
│   ├── webdav-client.ts    # WebDAV
│   ├── onedrive-client.ts / gdrive-client.ts / baiduyun-client.ts / alicloud-client.ts
│   ├── client-factory.ts   # 按配置实例化客户端
│   ├── folders.ts          # 虚拟目录树 + 权限解析
│   ├── users.ts / auth.ts / password.ts   # 用户与会话
│   └── shares.ts / audit.ts
├── routes/                 # 页面与 API（home / share / api.*）
└── components/             # 预览器、对话框、管理面板
```

## 开源许可

MIT
