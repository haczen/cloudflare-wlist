// Telegram 存储后端：实现与 S3 等一致的客户端接口。
// 对象本体是 TG 消息，目录/元数据在 D1（tg_objects 表）——
// listObjects 按 key 前缀查表；putObject=sendDocument+记表；
// getObject=getFile 流；deleteObject=deleteMessage+删行。

import type { S3Object, ListObjectsResult } from "./s3-client";
import {
	sendDocument,
	deleteMessage,
	getFileStream,
	TG_UPLOAD_LIMIT,
	TG_DOWNLOAD_LIMIT,
} from "./telegram-client";

export class TelegramClient {
	private storageId: number;
	private botToken: string;
	private chatId: string;
	private db: D1Database;

	constructor(opts: {
		storageId: number;
		db: D1Database;
		botToken: string;
		chatId: string;
	}) {
		this.storageId = opts.storageId;
		this.botToken = opts.botToken;
		this.chatId = opts.chatId;
		this.db = opts.db;
	}

	/** 真实大小在 TG 文件实体上；D1 行存的是上传时的大小 */
	async listObjects(
		prefix: string = "",
		delimiter: string = "/"
	): Promise<ListObjectsResult> {
		const norm = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;
		const result = await this.db
			.prepare("SELECT * FROM tg_objects WHERE storage_id = ? ORDER BY object_key")
			.bind(this.storageId)
			.all<{
				object_key: string;
				size: number;
				content_type: string;
				created_at: string;
			}>();
		const rows = result.results ?? [];
		const objects: S3Object[] = [];
		const prefixes: string[] = [];
		const seenDirs = new Set<string>();
		for (const r of rows) {
			if (norm && !r.object_key.startsWith(norm)) continue;
			const rest = r.object_key.slice(norm.length);
			if (!rest) continue;
			const slash = rest.indexOf("/");
			if (slash >= 0 && delimiter) {
				// 目录项：同级前缀聚合成一个文件夹
				const dir = norm + rest.slice(0, slash + 1);
				if (!seenDirs.has(dir)) {
					seenDirs.add(dir);
					prefixes.push(dir);
					objects.push({
						key: dir,
						name: rest.slice(0, slash),
						size: 0,
						lastModified: "",
						isDirectory: true,
					});
				}
			} else {
				objects.push({
					key: r.object_key,
					name: rest,
					size: r.size,
					lastModified: r.created_at,
					isDirectory: false,
				});
			}
		}
		objects.sort((a, b) =>
			a.isDirectory !== b.isDirectory
				? a.isDirectory
					? -1
					: 1
				: a.name.localeCompare(b.name)
		);
		return { objects, prefixes, isTruncated: false };
	}

	async putObject(
		key: string,
		body: ArrayBuffer | string | ReadableStream<Uint8Array>,
		contentType: string
	): Promise<void> {
		if (typeof body === "string") body = new TextEncoder().encode(body).buffer as ArrayBuffer;
		const size =
			body instanceof ArrayBuffer ? body.byteLength : 0; // 流式无长度，sendDocument 自己量
		if (size > TG_UPLOAD_LIMIT) {
			throw new Error(`Telegram 单文件上传上限 50MB（${(size / 1048576).toFixed(1)}MB），大文件请用聚合盘模式`);
		}
		const sent = await sendDocument(
			this.botToken,
			this.chatId,
			key.split("/").pop() || "file",
			body,
			contentType || "application/octet-stream",
			size
		);
		await this.db
			.prepare(
				`INSERT INTO tg_objects (storage_id, object_key, chat_id, message_id, file_id, file_unique_id, size, content_type)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(storage_id, object_key) DO UPDATE SET
				   chat_id=excluded.chat_id, message_id=excluded.message_id,
				   file_id=excluded.file_id, file_unique_id=excluded.file_unique_id,
				   size=excluded.size, content_type=excluded.content_type`
			)
			.bind(
				this.storageId,
				key,
				this.chatId,
				sent.messageId,
				sent.fileId,
				sent.fileUniqueId,
				size,
				contentType
			)
			.run();
	}

	async getObject(key: string, rangeHeader?: string): Promise<Response> {
		const row = await this.db
			.prepare("SELECT * FROM tg_objects WHERE storage_id = ? AND object_key = ?")
			.bind(this.storageId, key)
			.first<{ file_id: string; size: number; content_type: string }>();
		if (!row) {
			return new Response("Not found", { status: 404 });
		}
		if (row.size > TG_DOWNLOAD_LIMIT) {
			return new Response(
				`Telegram Bot API 下载上限 20MB（该对象 ${(row.size / 1048576).toFixed(1)}MB），请通过聚合盘通道下载`,
				{ status: 422 }
			);
		}
		void rangeHeader; // TG 不支持 Range，忽略（聚合盘整片下载不走这里）
		const { body, size } = await getFileStream(this.botToken, row.file_id);
		return new Response(body, {
			headers: {
				"Content-Type": row.content_type || "application/octet-stream",
				...(size ? { "Content-Length": String(size) } : {}),
			},
		});
	}

	async deleteObject(key: string): Promise<void> {
		const row = await this.db
			.prepare("SELECT * FROM tg_objects WHERE storage_id = ? AND object_key = ?")
			.bind(this.storageId, key)
			.first<{ chat_id: string; message_id: number }>();
		if (!row) return;
		await deleteMessage(this.botToken, row.chat_id, row.message_id);
		await this.db
			.prepare("DELETE FROM tg_objects WHERE storage_id = ? AND object_key = ?")
			.bind(this.storageId, key)
			.run();
	}

	async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
		const row = await this.db
			.prepare("SELECT size, content_type, created_at FROM tg_objects WHERE storage_id = ? AND object_key = ?")
			.bind(this.storageId, key)
			.first<{ size: number; content_type: string; created_at: string }>();
		if (!row) return null;
		return {
			contentLength: row.size,
			contentType: row.content_type,
			lastModified: row.created_at,
		};
	}

	// ---- 以下能力 TG 盘不支持：由上层（聚合盘/路由）规避或降级 ----

	async getSignedUrl(): Promise<string> {
		throw new Error("Telegram 盘不支持签名直链，走代理通道");
	}
	async getSignedPutUrl(): Promise<string> {
		throw new Error("Telegram 盘不支持直传，走 multipart 代理通道");
	}
	async getSignedUploadPartUrl(): Promise<string> {
		throw new Error("Telegram 盘不支持直传分块");
	}
	async initiateMultipartUpload(): Promise<string> {
		throw new Error("Telegram 盘不支持 multipart；大文件请用聚合盘模式");
	}
	async uploadPart(): Promise<string> {
		throw new Error("Telegram 盘不支持 multipart");
	}
	async completeMultipartUpload(): Promise<void> {
		throw new Error("Telegram 盘不支持 multipart");
	}
	async abortMultipartUpload(): Promise<void> {
		/* no-op */
	}
	async createFolder(): Promise<void> {
		/* TG 无目录实体，元数据表按需生成 */
	}
	async copyObject(): Promise<void> {
		throw new Error("Telegram 盘不支持服务端复制");
	}
	async renameObject(): Promise<void> {
		throw new Error("Telegram 盘不支持重命名");
	}
	async deleteObjects(keys: string[]): Promise<number> {
		let n = 0;
		for (const k of keys) {
			await this.deleteObject(k);
			n++;
		}
		return n;
	}
}
