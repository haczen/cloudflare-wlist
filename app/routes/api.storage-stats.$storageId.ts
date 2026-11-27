import type { Route } from "./+types/api.storage-stats.$storageId";
import { requireAuth } from "~/lib/auth";
import { getStorageById, initDatabase } from "~/lib/storage";
import { createClient, withClientState, type StorageClient } from "~/lib/client-factory";
import { getFileExtension } from "~/lib/file-utils";
import { getAllFolders, type Folder } from "~/lib/folders";

interface FolderStat {
	folderId: number;
	name: string;
	/** 盘内路径（桶内前缀） */
	storagePath: string;
	/** normal = 单独存储到此桶；pool = 分开存储（此桶是成员之一） */
	mode: "normal" | "pool";
	size: number;
	fileCount: number;
}

interface StorageStats {
	totalSize: number;
	fileCount: number;
	folderCount: number;
	typeDistribution: Record<string, { count: number; size: number }>;
	/** 按盘分组：该桶上每个盘各占多少。聚合盘只统计落在此桶的部分 */
	byFolder: FolderStat[];
}

function isMissingDirectoryError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return /(\b404\b|not found)/i.test(error.message);
}

/**
 * 找出文件 key 所属的盘（取 storagePath 最长前缀匹配的那个）。
 * 聚合盘的分片落在 <storagePath>/.wlistpool/ 下，同样归到该盘。
 */
function matchFolder(
	key: string,
	folders: Folder[]
): Folder | null {
	let best: Folder | null = null;
	for (const f of folders) {
		const fp = f.storagePath;
		if (!fp) continue; // 盘挂在桶根：所有文件都算它的，但留到最后兜底
		if (key === fp || key.startsWith(fp + "/")) {
			if (!best || fp.length > best.storagePath.length) {
				best = f;
			}
		}
	}
	// 兜底：挂在桶根的盘
	if (!best) {
		for (const f of folders) {
			if (!f.storagePath) {
				best = f;
				break;
			}
		}
	}
	return best;
}

/** BFS 遍历全部目录，统计文件数/大小/类型分布，并按盘分组 */
async function collectStats(
	client: StorageClient,
	/** 该桶关联的盘（storageId 匹配，或聚合盘的 poolMembers 含此桶） */
	folders: Folder[],
	prefix: string = ""
): Promise<StorageStats> {
	const stats: StorageStats = {
		totalSize: 0,
		fileCount: 0,
		folderCount: 0,
		typeDistribution: {},
		byFolder: folders.map((f) => ({
			folderId: f.id,
			name: f.name,
			storagePath: f.storagePath,
			mode: f.mode,
			size: 0,
			fileCount: 0,
		})),
	};
	const byFolderId = new Map(stats.byFolder.map((fs) => [fs.folderId, fs]));

	const countFile = (key: string, size: number) => {
		stats.fileCount++;
		stats.totalSize += size;

		const name = key.split("/").pop() || key;
		const ext = getFileExtension(name).toLowerCase() || "no-extension";
		if (!stats.typeDistribution[ext]) {
			stats.typeDistribution[ext] = { count: 0, size: 0 };
		}
		stats.typeDistribution[ext].count++;
		stats.typeDistribution[ext].size += size;

		// 归到所属盘
		const folder = matchFolder(key, folders);
		if (folder) {
			const fs = byFolderId.get(folder.id);
			if (fs) {
				fs.size += size;
				fs.fileCount++;
			}
		}
	};

	const queue: string[] = [prefix];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const currentPrefix = queue.shift()!;

		if (visited.has(currentPrefix)) {
			continue;
		}
		visited.add(currentPrefix);

		try {
			let result = await client.listObjects(currentPrefix, "/", 1000);

			for (const obj of result.objects) {
				if (!obj.isDirectory) {
					countFile(obj.key || obj.name, obj.size);
				}
			}

			for (const prefixPath of result.prefixes) {
				stats.folderCount++;
				queue.push(prefixPath);
			}

			// 分页处理
			while (result.isTruncated && result.nextContinuationToken) {
				result = await client.listObjects(
					currentPrefix,
					"/",
					1000,
					result.nextContinuationToken
				);

				for (const obj of result.objects) {
					if (!obj.isDirectory) {
						countFile(obj.key || obj.name, obj.size);
					}
				}

				for (const prefixPath of result.prefixes) {
					stats.folderCount++;
					queue.push(prefixPath);
				}
			}
		} catch (error) {
			if (currentPrefix && isMissingDirectoryError(error)) {
				console.warn(
					`Skipping missing directory while collecting stats: ${currentPrefix}`
				);
				continue;
			}
			console.error(`Error listing objects at ${currentPrefix}:`, error);
			throw error;
		}
	}

	return stats;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const { isAdmin } = await requireAuth(request, db);
	if (!isAdmin) {
		return Response.json({ error: "Unauthorized" }, { status: 403 });
	}

	const storageId = parseInt(params.storageId, 10);
	if (!storageId) {
		return Response.json({ error: "Invalid storage ID" }, { status: 400 });
	}

	try {
		const storage = await getStorageById(db, storageId);
		if (!storage) {
			return Response.json({ error: "Storage not found" }, { status: 404 });
		}

		// 该桶关联的盘：单独存储到此桶的（storageId 匹配），
		// 或聚合盘成员包含此桶的（poolMembers 含 storageId，或 poolMembers 空=全部桶）
		const allFolders = await getAllFolders(db);
		const relatedFolders = allFolders.filter(
			(f) =>
				f.storageId === storageId ||
				(f.mode === "pool" &&
					(f.poolMembers.length === 0 || f.poolMembers.includes(storageId)))
		);

		const client = createClient(storage, db, storage.id);
		const stats = await withClientState(client, db, storageId, () =>
			collectStats(client, relatedFolders)
		);
		return Response.json({ stats });
	} catch (error) {
		console.error("Error collecting storage stats:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to collect storage statistics",
			},
			{ status: 500 }
		);
	}
}
