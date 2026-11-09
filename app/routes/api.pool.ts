// 聚合盘 API
// - GET  /api/pool?folderId=N        → 目录下的聚合文件列表
// - POST /api/pool?action=init       → 创建聚合文件（规划分片分布）
// - POST /api/pool?action=chunk-url  → 取某分片的直传签名 URL
// - POST /api/pool?action=complete   → 全部分片完成，标记 ready
// 文件级操作见 api.pool.$fileId.ts

import type { Route } from "./+types/api.pool";
import { requireAuth } from "~/lib/auth";
import { initDatabase, getStorageById, getAllStorages } from "~/lib/storage";
import { getFolderById, computeFolderAccess } from "~/lib/folders";
import {
	createPoolFile,
	listPoolFiles,
	completePoolFile,
	getPoolFile,
	resolvePoolMembers,
} from "~/lib/pool";
import { createClient } from "~/lib/client-factory";
import { getRequestMeta, logAudit } from "~/lib/audit";

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const url = new URL(request.url);
	const folderId = parseInt(url.searchParams.get("folderId") || "0", 10);
	if (!folderId) {
		return Response.json({ error: "folderId 必填" }, { status: 400 });
	}
	const folder = await getFolderById(db, folderId);
	if (!folder) {
		return Response.json({ error: "目录不存在" }, { status: 404 });
	}

	// 列表权限与普通目录一致：公开目录访客可看
	const { user, isAdmin } = await requireAuth(request, db);
	const { getAllFolders, getUserFolders, computeFolderAccess } =
		await import("~/lib/folders");
	const all = await getAllFolders(db);
	const assigned = user ? await getUserFolders(db, user.id) : [];
	const access = isAdmin
		? { list: true, download: true, upload: true }
		: computeFolderAccess(all, assigned, folder.storageId, folder.storagePath);
	if (!access.list) {
		return Response.json({ error: "没有浏览权限" }, { status: 403 });
	}

	const files = await listPoolFiles(db, folderId);
	return Response.json({ files });
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const url = new URL(request.url);
	const action = url.searchParams.get("action");
	const body = (await request.json().catch(() => ({}))) as Record<string, any>;

	const { user, isAdmin } = await requireAuth(request, db);

	// 上传类操作要求目录上传权限（含公开目录的访客上传）
	if (action === "init" || action === "chunk-url" || action === "complete") {
		const fileId = action === "init" ? null : String(body.fileId || "");
		let folderId: number | null = null;
		if (action === "init") {
			folderId = Number(body.folderId) || null;
		} else {
			const pf = fileId ? await getPoolFile(db, fileId) : null;
			folderId = pf?.folderId ?? null;
		}
		if (!folderId) {
			return Response.json({ error: "缺少目录信息" }, { status: 400 });
		}
		const folder = await getFolderById(db, folderId);
		if (!folder) {
			return Response.json({ error: "目录不存在" }, { status: 404 });
		}
		const { getAllFolders, getUserFolders, computeFolderAccess } =
			await import("~/lib/folders");
		const all = await getAllFolders(db);
		const assigned = user ? await getUserFolders(db, user.id) : [];
		const access = isAdmin
			? { list: true, download: true, upload: true }
			: computeFolderAccess(all, assigned, folder.storageId, folder.storagePath);
		if (!access.upload) {
			return Response.json({ error: "没有上传权限" }, { status: 403 });
		}
	}

	if (action === "init") {
		const folderId = Number(body.folderId);
		const name = String(body.name || "").trim();
		const size = Number(body.size) || 0;
		const contentType = String(body.contentType || "application/octet-stream");
		if (!folderId || !name || name.includes("/") || size <= 0) {
			return Response.json({ error: "参数不合法" }, { status: 400 });
		}
		const folder = await getFolderById(db, folderId);
		if (!folder || folder.mode !== "pool") {
			return Response.json({ error: "不是聚合盘目录" }, { status: 400 });
		}
		// 池成员：目录配置的成员；未配置 = 全部 S3 桶平均分配
		const storages = (await getAllStorages(db)).filter(
			(s) => s.type === "s3"
		);
		const members = resolvePoolMembers(
			folder,
			storages.map((s) => s.id)
		);
		if (members.length === 0) {
			return Response.json({ error: "没有可用的存储桶" }, { status: 400 });
		}
		const file = await createPoolFile(db, folder, name, size, contentType, members);
		await logAudit(db, {
			action: "pool.init",
			userType: isAdmin ? "admin" : user ? "user" : "guest",
			ip: meta.ip,
			userAgent: meta.userAgent,
			storageId: members[0],
			path: `${folder.storagePath}/${name}`,
			detail: { fileId: file.id, size, chunks: file.chunks.length, members },
		});
		return Response.json({
			file: {
				id: file.id,
				chunkSize: file.chunkSize,
				chunks: file.chunks,
			},
		});
	}

	if (action === "chunk-url") {
		const fileId = String(body.fileId || "");
		const index = Number(body.index);
		const file = await getPoolFile(db, fileId);
		if (!file) {
			return Response.json({ error: "聚合文件不存在" }, { status: 404 });
		}
		const chunk = file.chunks.find((c) => c.i === index);
		if (!chunk) {
			return Response.json({ error: "分片不存在" }, { status: 404 });
		}
		const storage = await getStorageById(db, chunk.storageId);
		if (!storage) {
			return Response.json({ error: "分片所在桶不存在" }, { status: 404 });
		}
		const client = createClient(storage) as unknown as {
			getSignedPutUrl?: (key: string, expiresIn?: number) => Promise<string>;
		};
		if (typeof client.getSignedPutUrl !== "function") {
			return Response.json({ url: null });
		}
		const url2 = await client.getSignedPutUrl(chunk.key, 3600);
		return Response.json({ url: url2 });
	}

	if (action === "complete") {
		const fileId = String(body.fileId || "");
		await completePoolFile(db, fileId);
		const file = await getPoolFile(db, fileId);
		await logAudit(db, {
			action: "pool.complete",
			userType: isAdmin ? "admin" : user ? "user" : "guest",
			ip: meta.ip,
			userAgent: meta.userAgent,
			path: file?.name,
			detail: { fileId, size: file?.size, chunks: file?.chunks.length },
		});
		return Response.json({ success: true });
	}

	return Response.json({ error: "Unknown action" }, { status: 400 });
}
