// 聚合盘引擎：把一个大文件切成多个 chunk，轮询分布到多个桶。
// 清单（chunks 元数据）存 D1（pool_files 表），chunk 对象本体存各桶
// `<folderPath>/.wlistpool/<fileId>/<序号>`，普通目录列表会隐藏该前缀。

import type { Folder } from "./folders";
import { TG_POOL_CHUNK_SIZE } from "./telegram-client";

export interface PoolChunkInfo {
	/** 分片序号（0 起） */
	i: number;
	/** 落在哪个桶 */
	storageId: number;
	/** 桶内对象 key（含目录前缀与 .wlistpool） */
	key: string;
	/** 分片字节数 */
	size: number;
	/** 在源文件中的起始偏移 */
	start: number;
	/** 该片落在 Telegram 盘（上传走单片 PUT/sendDocument，无 multipart） */
	telegram?: boolean;
}

export interface PoolFile {
	id: string;
	folderId: number;
	name: string;
	size: number;
	chunkSize: number;
	contentType: string;
	status: "uploading" | "ready";
	chunks: PoolChunkInfo[];
	createdAt: string;
}

interface PoolFileRow {
	id: string;
	folder_id: number;
	name: string;
	size: number;
	chunk_size: number;
	content_type: string | null;
	status: string;
	chunks: string;
	created_at: string;
}

function rowToPoolFile(row: PoolFileRow): PoolFile {
	let chunks: PoolChunkInfo[] = [];
	try {
		const parsed = JSON.parse(row.chunks);
		if (Array.isArray(parsed)) chunks = parsed;
	} catch {
		/* 损坏清单按空处理 */
	}
	return {
		id: row.id,
		folderId: row.folder_id,
		name: row.name,
		size: row.size,
		chunkSize: row.chunk_size,
		contentType: row.content_type || "application/octet-stream",
		status: row.status === "ready" ? "ready" : "uploading",
		chunks,
		createdAt: row.created_at,
	};
}

/**
 * 分片大小：默认 256MB；但保证总 chunk 数 ≤ 40 ——
 * 下载回源时每个 chunk 是一次子请求，Workers 免费版单请求上限 50 个子请求。
 * 上限 5GB（S3 单对象限制），下限 256MB。
 * Telegram 成员盘例外：Bot API 下载上限 20MB，固定 15MB/片（子请求数由下载端分段控制）。
 */
export function computeChunkSize(size: number, hasTelegramMember = false): number {
	const MB = 1024 * 1024;
	if (hasTelegramMember) return TG_POOL_CHUNK_SIZE;
	const MIN = 256 * MB;
	const MAX = 5 * 1024 * MB;
	if (size <= 0) return MIN;
	return Math.min(MAX, Math.max(MIN, Math.ceil(size / 40 / MB) * MB));
}

/** 目录的池成员：poolMembers 为空 = 全部 S3 兼容桶自动平均分配 */
export function resolvePoolMembers(
	folder: Folder,
	allStorageIds: number[]
): number[] {
	if (folder.poolMembers && folder.poolMembers.length > 0) {
		const valid = folder.poolMembers.filter((id) => allStorageIds.includes(id));
		if (valid.length > 0) return valid;
	}
	return allStorageIds;
}

/** 轮询分布：chunk i → members[i mod N]。telegramMembers 非空时用 15MB 分片 */
export function planPoolChunks(
	folder: Folder,
	fileId: string,
	size: number,
	memberIds: number[],
	telegramMemberIds: number[] = []
): PoolChunkInfo[] {
	const chunkSize = computeChunkSize(size, telegramMemberIds.length > 0);
	const prefix = folder.storagePath
		? `${folder.storagePath}/.wlistpool/${fileId}/`
		: `.wlistpool/${fileId}/`;
	const chunks: PoolChunkInfo[] = [];
	const total = Math.max(1, Math.ceil(size / chunkSize));
	for (let i = 0; i < total; i++) {
		const start = i * chunkSize;
		const storageId = memberIds[i % memberIds.length];
		chunks.push({
			i,
			storageId,
			key: `${prefix}${String(i).padStart(4, "0")}`,
			size: Math.min(chunkSize, size - start),
			start,
			...(telegramMemberIds.includes(storageId) ? { telegram: true } : {}),
		});
	}
	return chunks;
}

export async function createPoolFile(
	db: D1Database,
	folder: Folder,
	name: string,
	size: number,
	contentType: string,
	memberIds: number[],
	telegramMemberIds: number[] = []
): Promise<PoolFile> {
	const id = crypto.randomUUID();
	const chunkSize = computeChunkSize(size, telegramMemberIds.length > 0);
	const chunks = planPoolChunks(folder, id, size, memberIds, telegramMemberIds);
	await db
		.prepare(
			`INSERT INTO pool_files (id, folder_id, name, size, chunk_size, content_type, status, chunks)
			 VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?)`
		)
		.bind(id, folder.id, name, size, chunkSize, contentType, JSON.stringify(chunks))
		.run();
	return {
		id,
		folderId: folder.id,
		name,
		size,
		chunkSize,
		contentType,
		status: "uploading",
		chunks,
		createdAt: new Date().toISOString(),
	};
}

export async function getPoolFile(
	db: D1Database,
	id: string
): Promise<PoolFile | null> {
	const row = await db
		.prepare("SELECT * FROM pool_files WHERE id = ?")
		.bind(id)
		.first<PoolFileRow>();
	return row ? rowToPoolFile(row) : null;
}

/** 目录下已就绪的聚合文件（按创建时间倒序，配合前端默认最新优先） */
export async function listPoolFiles(
	db: D1Database,
	folderId: number
): Promise<PoolFile[]> {
	const result = await db
		.prepare(
			"SELECT * FROM pool_files WHERE folder_id = ? AND status = 'ready' ORDER BY created_at DESC, id DESC"
		)
		.bind(folderId)
		.all<PoolFileRow>();
	return (result.results ?? []).map(rowToPoolFile);
}

export async function completePoolFile(db: D1Database, id: string): Promise<void> {
	await db
		.prepare("UPDATE pool_files SET status = 'ready' WHERE id = ?")
		.bind(id)
		.run();
}

export async function renamePoolFile(
	db: D1Database,
	id: string,
	name: string
): Promise<void> {
	await db
		.prepare("UPDATE pool_files SET name = ? WHERE id = ?")
		.bind(name, id)
		.run();
}

export async function deletePoolFileRecord(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM pool_files WHERE id = ?").bind(id).run();
}

/** 删除目录时清掉其下全部聚合文件记录（chunk 对象由调用方删） */
export async function deletePoolFilesByFolder(
	db: D1Database,
	folderId: number
): Promise<PoolFile[]> {
	const files = await listPoolFilesIncludeUploading(db, folderId);
	await db
		.prepare("DELETE FROM pool_files WHERE folder_id = ?")
		.bind(folderId)
		.run();
	return files;
}

async function listPoolFilesIncludeUploading(
	db: D1Database,
	folderId: number
): Promise<PoolFile[]> {
	const result = await db
		.prepare("SELECT * FROM pool_files WHERE folder_id = ?")
		.bind(folderId)
		.all<PoolFileRow>();
	return (result.results ?? []).map(rowToPoolFile);
}

/** 按 chunk 的 storageId 分组（删对象时每桶一次批量请求） */
export function groupChunksByStorage(chunks: PoolChunkInfo[]): Map<number, string[]> {
	const map = new Map<number, string[]>();
	for (const c of chunks) {
		const list = map.get(c.storageId) || [];
		list.push(c.key);
		map.set(c.storageId, list);
	}
	return map;
}

// ---------- 过期自动清理（传输盘：文件保留 7 天） ----------
// 注意：UI 介绍文案（home.tsx 传输盘横幅）与这里的 7 天保持一致

export const POOL_RETENTION_DAYS = 7;

/** 删除一个聚合文件的各桶分片对象（清单记录由调用方删） */
export async function deletePoolChunks(
	db: D1Database,
	chunks: PoolChunkInfo[]
): Promise<number> {
	const { getStorageById } = await import("./storage");
	const { createClient, withClientState } = await import("./client-factory");
	let deleted = 0;
	for (const [storageId, keys] of groupChunksByStorage(chunks)) {
		const storage = await getStorageById(db, storageId);
		if (!storage) continue;
		const client = createClient(storage);
		const batch = client as unknown as {
			deleteObjects?: (keys: string[]) => Promise<number>;
		};
		try {
			if (typeof batch.deleteObjects === "function") {
				deleted += await withClientState(client, db, storageId, () =>
					batch.deleteObjects!(keys)
				);
			} else {
				for (const key of keys) {
					await withClientState(client, db, storageId, () => client.deleteObject(key));
					deleted++;
				}
			}
		} catch {
			// 单桶失败不阻断
		}
	}
	return deleted;
}

/**
 * 清理超过保留期的聚合文件（含分片对象与 D1 清单）。
 * created_at 是 datetime('now') 空格格式，SQL 端同格式比较，无时区问题。
 * 返回清理的文件数。由目录访问时惰性触发 + 每日 Cron 兜底。
 */
export async function cleanExpiredPoolFiles(db: D1Database): Promise<number> {
	const result = await db
		.prepare(
			`SELECT * FROM pool_files WHERE created_at < datetime('now', ?)`
		)
		.bind(`-${POOL_RETENTION_DAYS} days`)
		.all<PoolFileRow>();
	const files = (result.results ?? []).map(rowToPoolFile);
	for (const file of files) {
		await deletePoolChunks(db, file.chunks);
		await deletePoolFileRecord(db, file.id);
	}
	return files.length;
}
