import type { Route } from "./+types/api.storage-stats.$storageId";
import { requireAuth } from "~/lib/auth";
import { getStorageById, initDatabase } from "~/lib/storage";
import { createClient, withClientState, type StorageClient } from "~/lib/client-factory";
import { getFileExtension } from "~/lib/file-utils";

interface StorageStats {
	totalSize: number;
	fileCount: number;
	folderCount: number;
	typeDistribution: Record<string, { count: number; size: number }>;
}

function isMissingDirectoryError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return /(\b404\b|not found)/i.test(error.message);
}

/** BFS 遍历全部目录，统计文件数/大小/类型分布 */
async function collectStats(
	client: StorageClient,
	prefix: string = ""
): Promise<StorageStats> {
	const stats: StorageStats = {
		totalSize: 0,
		fileCount: 0,
		folderCount: 0,
		typeDistribution: {},
	};

	const countFile = (name: string, size: number) => {
		stats.fileCount++;
		stats.totalSize += size;

		const ext = getFileExtension(name).toLowerCase() || "no-extension";
		if (!stats.typeDistribution[ext]) {
			stats.typeDistribution[ext] = { count: 0, size: 0 };
		}
		stats.typeDistribution[ext].count++;
		stats.typeDistribution[ext].size += size;
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
					countFile(obj.name, obj.size);
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
						countFile(obj.name, obj.size);
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

		const client = createClient(storage);
		const stats = await withClientState(client, db, storageId, () =>
			collectStats(client)
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
