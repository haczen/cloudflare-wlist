// Telegram Bot 入口：webhook 处理 / 指令 / 文件转存 / 通知
//
// 指令（仅白名单用户可用，白名单 = telegram 盘配置的 chatId）：
//   /start      欢迎与帮助
//   /list       列出传输盘（聚合盘目录）里的文件
//   /link <名>  回某个文件的下载直链
//   发送文件    ≤20MB 自动转存进传输盘（>20MB 提示走网页，TG 单条消息拉不回来）
//
// 通知：上传完成、7 天清理结果。

import {
	sendMessage,
	getFileStream,
	TG_DOWNLOAD_LIMIT,
} from "./telegram-client";
import { initDatabase, getAllStorages } from "./storage";
import { getFolderById } from "./folders";
import { listPoolFiles, getPoolFile } from "./pool";

interface TgStorageInfo {
	storageId: number;
	botToken: string;
	chatId: string;
}

/** 取配置好的 telegram 盘（一个站点通常只配一个） */
async function getTgStorage(db: D1Database): Promise<TgStorageInfo | null> {
	const storages = await getAllStorages(db);
	const tg = storages.find((s) => s.type === "telegram");
	if (!tg) return null;
	const botToken = String(tg.config?.botToken || "");
	const chatId = String(tg.config?.chatId || "");
	if (!botToken || !chatId) return null;
	return { storageId: tg.id, botToken, chatId };
}

/** 找聚合盘模式的公开目录（优先 name 含「传输」的）作为转存目标 */
async function findTransferFolder(db: D1Database): Promise<number | null> {
	const result = await db
		.prepare("SELECT * FROM folders WHERE mode = 'pool' ORDER BY id")
		.all<{ id: number; name: string; is_public: number }>();
	const rows = result.results ?? [];
	if (rows.length === 0) return null;
	const preferred = rows.find((r) => r.is_public === 1 && r.name.includes("传输"));
	return (preferred || rows[0]).id;
}

function fmtSize(n: number): string {
	if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
	if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${n} B`;
}

export async function handleTelegramWebhook(
	request: Request,
	db: D1Database,
	env: { SITE_TITLE?: string }
): Promise<Response> {
	if (!request.headers.get("X-Telegram-Bot-Api-Secret-Token")) {
		// webhook 注册时带 secret，这里只做存在性校验（具体值在注册时由 bot token 派生）
		return new Response("forbidden", { status: 403 });
	}
	const update = (await request.json().catch(() => null)) as {
		message?: {
			message_id: number;
			chat: { id: number };
			from?: { id: number };
			text?: string;
			document?: {
				file_id: string;
				file_name?: string;
				file_size?: number;
				mime_type?: string;
			};
		};
	} | null;
	if (!update?.message) return new Response("ok");

	const msg = update.message;
	await initDatabase(db);
	const tg = await getTgStorage(db);
	if (!tg) {
		return new Response("ok"); // 未配置 telegram 盘：忽略
	}
	// 白名单：仅配置的 chatId 可操作
	if (String(msg.chat.id) !== tg.chatId) {
		await sendMessage(tg.botToken, String(msg.chat.id), "⛔ 未授权的访问。");
		return new Response("ok");
	}

	const siteTitle = env.SITE_TITLE || "WList";

	// ---- 文件转存 ----
	if (msg.document) {
		const doc = msg.document;
		const name = doc.file_name || "file";
		const size = doc.file_size ?? 0;
		if (size > TG_DOWNLOAD_LIMIT) {
			await sendMessage(
				tg.botToken,
				tg.chatId,
				`⚠️ <b>${name}</b>（${fmtSize(size)}）超过 20MB：Bot API 拉不回单条大消息。\n` +
					`请打开 ${siteTitle} 网页上传——聚合盘会自动切片（TG 盘每片 15MB）。`
			);
			return new Response("ok");
		}
		const folderId = await findTransferFolder(db);
		if (!folderId) {
			await sendMessage(tg.botToken, tg.chatId, "⚠️ 还没有聚合盘目录，请先在网页上创建。");
			return new Response("ok");
		}
		try {
			// 拉回文件 → 直传目标桶（文件本体不经过 TG 二次中转）
			const { body } = await getFileStream(tg.botToken, doc.file_id);
			const buf = await new Response(body).arrayBuffer();
			const { createClient } = await import("~/lib/client-factory");
			const folder = await getFolderById(db, folderId);
			if (!folder) throw new Error("目录不存在");
			// 选 folder.storageId 对应桶（聚合盘锚定桶）直存普通对象（key 带目录前缀）
			const { getStorageById } = await import("~/lib/storage");
			const storage = await getStorageById(db, folder.storageId);
			if (!storage) throw new Error("桶不存在");
			const client = createClient(storage, db, storage.id);
			const key = `${folder.storagePath ? folder.storagePath + "/" : ""}${name}`;
			const put = client as unknown as {
				putObject: (
					key: string,
					body: ArrayBuffer,
					contentType?: string
				) => Promise<void>;
			};
			await put.putObject(key, buf, doc.mime_type || "application/octet-stream");
			await sendMessage(
				tg.botToken,
				tg.chatId,
				`✅ <b>${name}</b>（${fmtSize(size)}）已转存到「${folder.name}」`
			);
		} catch (err) {
			await sendMessage(
				tg.botToken,
				tg.chatId,
				`❌ 转存失败：${err instanceof Error ? err.message : "未知错误"}`
			);
		}
		return new Response("ok");
	}

	// ---- 指令 ----
	const text = (msg.text || "").trim();
	if (!text) return new Response("ok");

	if (text === "/start" || text === "/help") {
		await sendMessage(
			tg.botToken,
			tg.chatId,
			`👋 我是 <b>${siteTitle}</b> 传输盘助手\n\n` +
				`📎 直接发文件给我（≤20MB）→ 自动转存到传输盘\n` +
				`📋 /list — 列出传输盘文件\n` +
				`🔗 /link 文件名 — 获取下载直链\n` +
				`ℹ️ 大文件请到网页上传（自动切片分布到多个盘）`
		);
		return new Response("ok");
	}

	if (text === "/list") {
		const folderId = await findTransferFolder(db);
		if (!folderId) {
			await sendMessage(tg.botToken, tg.chatId, "还没有聚合盘目录。");
			return new Response("ok");
		}
		// 聚合文件清单
		const poolFiles = await listPoolFiles(db, folderId);
		const lines: string[] = [];
		if (poolFiles.length > 0) {
			lines.push("<b>📦 聚合文件</b>");
			for (const f of poolFiles.slice(0, 20)) {
				lines.push(`• ${f.name}（${fmtSize(f.size)}）`);
			}
		}
		// 普通文件（锚定桶 + .wlistpool 之外的）
		try {
			const folder = await getFolderById(db, folderId);
			if (folder) {
				const { getStorageById } = await import("~/lib/storage");
				const storage = await getStorageById(db, folder.storageId);
				if (storage) {
					const { createClient } = await import("~/lib/client-factory");
					const client = createClient(storage, db, storage.id);
					const isPool = (key: string) =>
						key.includes("/.wlistpool/") || key.startsWith(".wlistpool/");
					const result = await client.listObjects(folder.storagePath, "/");
					const normal = result.objects.filter(
						(o) => !o.isDirectory && !isPool(o.key)
					);
					if (normal.length > 0) {
						lines.push("<b>🗂️ 普通文件</b>");
						for (const o of normal.slice(0, 20)) {
							lines.push(`• ${o.name}（${fmtSize(o.size)}）`);
						}
					}
				}
			}
		} catch {
			/* 桶列表失败只列聚合清单 */
		}
		await sendMessage(
			tg.botToken,
			tg.chatId,
			lines.length > 0
				? lines.join("\n") + (poolFiles.length > 20 ? "\n…" : "")
				: "传输盘是空的。发个文件给我试试 📎"
		);
		return new Response("ok");
	}

	if (text.startsWith("/link ")) {
		const query = text.slice(6).trim();
		const folderId = await findTransferFolder(db);
		if (!folderId) {
			await sendMessage(tg.botToken, tg.chatId, "还没有聚合盘目录。");
			return new Response("ok");
		}
		// 先找聚合清单，再找普通文件
		const poolFiles = await listPoolFiles(db, folderId);
		const hit = poolFiles.find((f) => f.name === query || f.name.includes(query));
		if (hit) {
			const base = new URL(request.url).origin;
			await sendMessage(
				tg.botToken,
				tg.chatId,
				`🔗 <b>${hit.name}</b>\n${base}/api/pool/${hit.id}?download=1`
			);
			return new Response("ok");
		}
		try {
			const folder = await getFolderById(db, folderId);
			if (folder) {
				const { getStorageById } = await import("~/lib/storage");
				const storage = await getStorageById(db, folder.storageId);
				if (storage) {
					const { createClient } = await import("~/lib/client-factory");
					const client = createClient(storage, db, storage.id);
					const result = await client.listObjects(folder.storagePath, "/");
					const obj = result.objects.find(
						(o) => !o.isDirectory && (o.name === query || o.name.includes(query))
					);
					if (obj) {
						const base = new URL(request.url).origin;
						const { encodeFilePath } = await import("~/lib/api-path");
						const url = `${base}/api/files/${storage.id}/${encodeFilePath(obj.key)}?action=download`;
						await sendMessage(tg.botToken, tg.chatId, `🔗 <b>${obj.name}</b>\n${url}`);
						return new Response("ok");
					}
				}
			}
		} catch {
			/* fallthrough */
		}
		await sendMessage(tg.botToken, tg.chatId, `没找到「${query}」，用 /list 看看文件名。`);
		return new Response("ok");
	}

	await sendMessage(tg.botToken, tg.chatId, "未知指令。发 /start 看帮助 📎");
	return new Response("ok");
}

/** 传输盘惰性清理/定时清理后的通知 */
export async function notifyRetentionCleanup(db: D1Database, deleted: number): Promise<void> {
	if (deleted <= 0) return;
	const tg = await getTgStorage(db);
	if (!tg) return;
	await sendMessage(
		tg.botToken,
		tg.chatId,
		`🧹 传输盘自动清理：${deleted} 个超过 7 天的文件已删除`
	);
}

/** 上传完成通知（由 api.pool complete 时调用） */
export async function notifyPoolUploaded(
	db: D1Database,
	fileId: string
): Promise<void> {
	const tg = await getTgStorage(db);
	if (!tg) return;
	const file = await getPoolFile(db, fileId);
	if (!file) return;
	await sendMessage(
		tg.botToken,
		tg.chatId,
		`📥 <b>${file.name}</b>（${fmtSize(file.size)}）上传完成\n分片：${file.chunks.length} 片`
	);
}
