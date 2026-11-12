// Telegram Bot API 客户端：把 TG 收藏夹当作一种存储后端。
// 限制（Bot API 硬性）：单文件下载 20MB、上传 50MB。
// 大文件由聚合盘模式切片规避（每片 15MB）。

export interface TelegramConfig {
	botToken: string;
	/** 允许操作的白名单 chat id */
	chatId: string;
}

/** D1 元数据表一行：一个 TG 消息文件（tg_objects） */
export interface TgObjectRow {
	id: number;
	storage_id: number;
	/** 桶内逻辑 key（含路径），如 "传输盘/.wlistpool/xxx/0000" */
	object_key: string;
	/** TG message chat id（字符串数字） */
	chat_id: string;
	/** TG message id */
	message_id: number;
	/** Bot API file_id（下载凭据，可能随 bot 重置而失效） */
	file_id: string;
	/** 文件唯一 id（跨会话稳定） */
	file_unique_id: string;
	size: number;
	content_type: string;
	created_at: string;
}

export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // Bot API getFile 硬上限
export const TG_UPLOAD_LIMIT = 50 * 1024 * 1024; // sendDocument 硬上限
/** 聚合盘成员含 TG 盘时的分片大小（留余量 < 20MB 下载限制） */
export const TG_POOL_CHUNK_SIZE = 15 * 1024 * 1024;

const API = (token: string, method: string) =>
	`https://api.telegram.org/bot${token}/${method}`;

async function tgCall<T>(
	token: string,
	method: string,
	body?: Record<string, unknown>
): Promise<T> {
	const res = await fetch(API(token, method), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
	if (!data.ok) {
		throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
	}
	return data.result as T;
}

export async function getMe(token: string) {
	return tgCall<{ id: number; username: string }>(token, "getMe");
}

export async function setWebhook(token: string, url: string, secret: string) {
	return tgCall<boolean>(token, "setWebhook", {
		url,
		secret_token: secret,
		drop_pending_updates: true,
	});
}

/** 上传一个文件到目标 chat（sendDocument），返回 message 与 file_id */
export async function sendDocument(
	token: string,
	chatId: string,
	fileName: string,
	body: ArrayBuffer | ReadableStream<Uint8Array>,
	contentType: string,
	size: number
): Promise<{ messageId: number; fileId: string; fileUniqueId: string }> {
	const form = new FormData();
	form.append("chat_id", chatId);
	const blob =
		body instanceof ArrayBuffer
			? new Blob([body], { type: contentType })
			: new Blob([body as unknown as BlobPart], { type: contentType });
	form.append("document", blob, fileName);
	const res = await fetch(API(token, "sendDocument"), { method: "POST", body: form });
	const data = (await res.json()) as {
		ok: boolean;
		description?: string;
		result?: { message_id: number; document?: { file_id: string; file_unique_id: string } };
	};
	if (!data.ok || !data.result?.document) {
		throw new Error(`Telegram sendDocument failed: ${data.description || res.status}`);
	}
	return {
		messageId: data.result.message_id,
		fileId: data.result.document.file_id,
		fileUniqueId: data.result.document.file_unique_id,
	};
}

export async function deleteMessage(token: string, chatId: string, messageId: number) {
	try {
		await tgCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
	} catch {
		// 消息可能已被删；忽略
	}
}

/** 拉取文件内容流（≤20MB）。file_path 有效期约 1 小时，随取随用 */
export async function getFileStream(
	token: string,
	fileId: string
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
	const info = await tgCall<{ file_path?: string; file_size?: number }>(
		token,
		"getFile",
		{ file_id: fileId }
	);
	if (!info.file_path) {
		throw new Error("Telegram getFile: no file_path");
	}
	const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
	if (!res.ok || !res.body) {
		throw new Error(`Telegram download failed: ${res.status}`);
	}
	return { body: res.body, size: info.file_size ?? 0 };
}

export async function sendMessage(
	token: string,
	chatId: string,
	text: string
): Promise<void> {
	await tgCall(token, "sendMessage", {
		chat_id: chatId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
	});
}
