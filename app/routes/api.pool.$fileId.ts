// 聚合盘文件级 API
// - GET    /api/pool/:fileId?download=1 → 顺序流式聚合下载（chunk 逐个回源拼接）
// - GET    /api/pool/:fileId            → 文件信息
// - POST   /api/pool/:fileId?action=rename  → 重命名（仅改 D1 清单，零数据搬移）
// - DELETE /api/pool/:fileId            → 删除（各桶批量删 chunk + 清单）

import type { Route } from "./+types/api.pool.$fileId";
import { requireAuth } from "~/lib/auth";
import { initDatabase, getStorageById } from "~/lib/storage";
import { getFolderById, getAllFolders, getUserFolders, computeFolderAccess } from "~/lib/folders";
import {
	getPoolFile,
	renamePoolFile,
	deletePoolFileRecord,
	groupChunksByStorage,
	type PoolFile,
} from "~/lib/pool";
import { createClient, withClientState } from "~/lib/client-factory";
import { getRequestMeta, logAudit } from "~/lib/audit";

async function resolveAccess(db: D1Database, request: Request, file: PoolFile) {
	const { user, isAdmin } = await requireAuth(request, db);
	if (isAdmin) return { isAdmin, access: { list: true, download: true, upload: true } };
	const folder = await getFolderById(db, file.folderId);
	if (!folder) return { isAdmin, access: { list: false, download: false, upload: false } };
	const all = await getAllFolders(db);
	const assigned = user ? await getUserFolders(db, user.id) : [];
	return {
		isAdmin,
		access: computeFolderAccess(all, assigned, folder.storageId, folder.storagePath),
	};
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const file = await getPoolFile(db, params.fileId || "");
	if (!file || file.status !== "ready") {
		return Response.json({ error: "文件不存在" }, { status: 404 });
	}

	const url = new URL(request.url);
	const { isAdmin, access } = await resolveAccess(db, request, file);

	// 文件信息
	if (url.searchParams.get("download") !== "1") {
		if (!isAdmin && !access.list) {
			return Response.json({ error: "没有浏览权限" }, { status: 403 });
		}
		return Response.json({
			file: {
				id: file.id,
				name: file.name,
				size: file.size,
				chunks: file.chunks.length,
				buckets: groupChunksByStorage(file.chunks).size,
				createdAt: file.createdAt,
			},
		});
	}

	// 聚合下载：逐 chunk 回源顺序拼接（Range 不支持，整文件下载）
	if (!isAdmin && !access.download) {
		return Response.json({ error: "没有下载权限" }, { status: 403 });
	}

	const meta = getRequestMeta(request);
	await logAudit(db, {
		action: "pool.download",
		userType: isAdmin ? "admin" : "guest",
		ip: meta.ip,
		userAgent: meta.userAgent,
		path: file.name,
		detail: { fileId: file.id, size: file.size, chunks: file.chunks.length },
	});

	const chunkStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for (const chunk of file.chunks) {
					const storage = await getStorageById(db, chunk.storageId);
					if (!storage) {
						throw new Error(`分片 ${chunk.i} 所在桶不存在`);
					}
					const client = createClient(storage);
					const resp = await client.getObject(chunk.key);
					if (!resp.ok || !resp.body) {
						throw new Error(`分片 ${chunk.i} 读取失败: ${resp.status}`);
					}
					const reader = resp.body.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value) controller.enqueue(value);
					}
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});

	const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return new Response(chunkStream, {
		headers: {
			"Content-Type": file.contentType || "application/octet-stream",
			"Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			"Content-Length": String(file.size),
		},
	});
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const file = await getPoolFile(db, params.fileId || "");
	if (!file) {
		return Response.json({ error: "文件不存在" }, { status: 404 });
	}
	const url = new URL(request.url);
	const action = url.searchParams.get("action");
	const { isAdmin, access } = await resolveAccess(db, request, file);

	if (request.method === "DELETE") {
		// 删除权限：与目录上传权限对齐（聚合盘公开目录允许访客清理，传输盘用后即删）
		if (!isAdmin && !access.upload) {
			return Response.json({ error: "没有删除权限" }, { status: 403 });
		}

		// 各桶批量删 chunk
		const grouped = groupChunksByStorage(file.chunks);
		let deleted = 0;
		for (const [storageId, keys] of grouped) {
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
				// 单桶失败不阻断：尽力删，记录仍会清理
			}
		}
		await deletePoolFileRecord(db, file.id);
		await logAudit(db, {
			action: "pool.delete",
			userType: isAdmin ? "admin" : "user",
			ip: meta.ip,
			userAgent: meta.userAgent,
			path: file.name,
			detail: { fileId: file.id, deleted },
		});
		return Response.json({ success: true, deleted });
	}

	if (request.method === "POST" && action === "rename") {
		// 重命名：仅改 D1 清单，零数据搬移
		if (!isAdmin && !access.upload) {
			return Response.json({ error: "没有权限" }, { status: 403 });
		}
		const body = (await request.json().catch(() => ({}))) as { name?: string };
		const name = String(body.name || "").trim();
		if (!name || name.includes("/")) {
			return Response.json({ error: "名称不合法" }, { status: 400 });
		}
		await renamePoolFile(db, file.id, name);
		await logAudit(db, {
			action: "pool.rename",
			userType: isAdmin ? "admin" : "user",
			ip: meta.ip,
			userAgent: meta.userAgent,
			path: file.name,
			detail: { fileId: file.id, newName: name },
		});
		return Response.json({ success: true, name });
	}

	return Response.json({ error: "Unknown action" }, { status: 400 });
}
