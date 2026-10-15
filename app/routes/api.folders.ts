import type { Route } from "./+types/api.folders";
import { requireAuth } from "~/lib/auth";
import { initDatabase, getStorageById } from "~/lib/storage";
import {
	getVisibleFolders,
	getFolderById,
	createFolderRecord,
	updateFolderRecord,
	deleteFolderRecord,
	resolveFolderAccess,
	buildFolderTree,
} from "~/lib/folders";
import { createClient, withClientState } from "~/lib/client-factory";
import { getRequestMeta, logAudit } from "~/lib/audit";

/** 递归列出目录下全部对象 key（含子目录占位），用于删除 */
async function listAllKeys(
	client: ReturnType<typeof createClient>,
	db: D1Database,
	storageId: number,
	path: string
): Promise<string[]> {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const result = await withClientState(client, db, storageId, () =>
			client.listObjects(path, "/", 1000, token)
		);
		for (const obj of result.objects) {
			if (!obj.isDirectory) keys.push(obj.key);
		}
		for (const obj of result.objects) {
			if (obj.isDirectory) {
				keys.push(...(await listAllKeys(client, db, storageId, obj.key)));
				keys.push(obj.key);
			}
		}
		token = result.nextContinuationToken;
	} while (token);
	return keys;
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { user } = await requireAuth(request, db);

	const folders = await getVisibleFolders(
		db,
		user ? { id: user.id, role: user.role } : null
	);
	return Response.json({
		folders: buildFolderTree(folders),
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);
	const { user, isAdmin } = await requireAuth(request, db);

	const method = request.method;
	const body = (await request.json().catch(() => ({}))) as Record<string, any>;

	// 新建目录：管理员任意建；普通用户可在自己有上传权限的目录下建子目录
	if (method === "POST") {
		const { name, parentId, storageId, isPublic } = body as {
			name?: string;
			parentId?: number | null;
			storageId?: number;
			isPublic?: boolean;
		};
		if (!name || !name.trim()) {
			return Response.json({ error: "目录名必填" }, { status: 400 });
		}

		let targetStorageId: number;
		let storagePath: string;
		if (parentId) {
			const parent = await getFolderById(db, parentId);
			if (!parent) {
				return Response.json({ error: "父目录不存在" }, { status: 404 });
			}
			// 非管理员：必须对父目录有上传权限
			if (!isAdmin) {
				const access = await resolveFolderAccess(
					db,
					user ? { id: user.id, role: user.role } : null,
					parent.storageId,
					parent.storagePath
				);
				if (!access.upload) {
					return Response.json({ error: "没有在该目录下创建的权限" }, { status: 403 });
				}
			}
			targetStorageId = parent.storageId;
			storagePath = parent.storagePath
				? `${parent.storagePath}/${name.trim()}`
				: name.trim();
		} else {
			if (!isAdmin) {
				return Response.json(
					{ error: "只有管理员可以创建顶层目录" },
					{ status: 403 }
				);
			}
			if (!storageId) {
				return Response.json({ error: "请选择存储桶" }, { status: 400 });
			}
			targetStorageId = storageId;
			storagePath = name.trim();
		}

		const storage = await getStorageById(db, targetStorageId);
		if (!storage) {
			return Response.json({ error: "存储不存在" }, { status: 404 });
		}

		// 先在桶里真实创建，再记虚拟目录
		try {
			const client = createClient(storage);
			await withClientState(client, db, targetStorageId, () =>
				client.createFolder(storagePath)
			);
		} catch (err) {
			return Response.json(
				{
					error:
						err instanceof Error
							? `桶内创建失败：${err.message}`
							: "桶内创建失败",
				},
				{ status: 500 }
			);
		}

		try {
			const folder = await createFolderRecord(db, {
				name: name.trim(),
				parentId: parentId || null,
				storageId: targetStorageId,
				storagePath,
				isPublic: !!isPublic,
			});
			await logAudit(db, {
				action: "folder.create",
				userType: isAdmin ? "admin" : "user",
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId: targetStorageId,
				path: storagePath,
				detail: { folderId: folder.id, isPublic: !!isPublic },
			});
			return Response.json({ folder });
		} catch (err) {
			// 记录失败但桶里已建目录——保留桶目录，返回错误让用户重试（重名时会走上面的重名校验）
			return Response.json(
				{ error: err instanceof Error ? err.message : "目录记录创建失败" },
				{ status: 400 }
			);
		}
	}

	// 更新（公开开关）
	if (method === "PUT") {
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}
		const { id, isPublic } = body as { id?: number; isPublic?: boolean };
		if (!id || isPublic === undefined) {
			return Response.json({ error: "id 与 isPublic 必填" }, { status: 400 });
		}
		const existing = await getFolderById(db, id);
		if (!existing) {
			return Response.json({ error: "目录不存在" }, { status: 404 });
		}
		const folder = await updateFolderRecord(db, id, { isPublic });
		await logAudit(db, {
			action: "folder.update",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			storageId: existing.storageId,
			path: existing.storagePath,
			detail: { folderId: id, isPublic },
		});
		return Response.json({ folder });
	}

	// 删除（桶内递归删除 + 记录级联）
	if (method === "DELETE") {
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}
		const id = parseInt(
			new URL(request.url).searchParams.get("id") || "0",
			10
		);
		if (!id) {
			return Response.json({ error: "id 必填" }, { status: 400 });
		}
		const folder = await getFolderById(db, id);
		if (!folder) {
			return Response.json({ error: "目录不存在" }, { status: 404 });
		}
		const storage = await getStorageById(db, folder.storageId);
		if (storage) {
			try {
				const client = createClient(storage);
				const keys = await listAllKeys(client, db, folder.storageId, folder.storagePath);
				for (const key of keys) {
					await withClientState(client, db, folder.storageId, () =>
						client.deleteObject(key)
					);
				}
				try {
					await withClientState(client, db, folder.storageId, () =>
						client.deleteObject(
							folder.storagePath.endsWith("/")
								? folder.storagePath
								: folder.storagePath + "/"
						)
					);
				} catch {
					// 占位对象可能不存在
				}
			} catch (err) {
				return Response.json(
					{
						error:
							err instanceof Error
								? `桶内删除失败：${err.message}`
								: "桶内删除失败",
					},
					{ status: 500 }
				);
			}
		}
		await deleteFolderRecord(db, id);
		await logAudit(db, {
			action: "folder.delete",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			storageId: folder.storageId,
			path: folder.storagePath,
			detail: { folderId: id, deletedKeys: true },
		});
		return Response.json({ success: true });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
