import type { Route } from "./+types/api.storages";
import {
	getAllStorages,
	getPublicStorages,
	getStorageById,
	createStorage,
	updateStorage,
	deleteStorage,
	initDatabase,
	exportStoragesForBackup,
	importStoragesFromBackup,
	type BackupData,
	type Storage,
} from "~/lib/storage";
import {
	requireAuth,
	createSession,
	deleteSession,
	validateAdmin,
	createSessionCookie,
	deleteSessionCookie,
	getSessionIdFromCookie,
} from "~/lib/auth";
import {
	getUserByUsername,
	getUserStorages,
	resolveStorageAccess,
	toPublicUser,
} from "~/lib/users";
import { hashPassword, verifyPassword } from "~/lib/password";
import { getRequestMeta, logAudit } from "~/lib/audit";

/** 把存储映射为带有效权限的响应对象 */
function storageWithAccess(
	s: Storage,
	access: { list: boolean; download: boolean; upload: boolean },
	isAdmin: boolean
) {
	const base: Record<string, unknown> = {
		id: s.id,
		name: s.name,
		type: s.type,
		isPublic: s.isPublic,
		guestList: s.guestList,
		guestDownload: s.guestDownload,
		guestUpload: s.guestUpload,
		// 当前访问者的实际权限
		access,
	};
	if (isAdmin) {
		Object.assign(base, {
			endpoint: s.endpoint,
			region: s.region,
			accessKeyId: s.accessKeyId,
			bucket: s.bucket,
			basePath: s.basePath,
			config: s.config,
			secretAccessKey: "***",
			saving: {},
		});
	}
	return base;
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const { user, isAdmin } = await requireAuth(request, db);

	if (isAdmin) {
		const storages = await getAllStorages(db);
		return Response.json({
			storages: storages.map((s) =>
				storageWithAccess(s, { list: true, download: true, upload: true }, true)
			),
			isAdmin: true,
			user: user ? toPublicUser(user) : null,
		});
	}

	// 访客 / 登录用户：公开存储 ∪（登录用户）被分配的存储
	const publicStorages = await getPublicStorages(db);
	const assigned = user ? await getUserStorages(db, user.id) : [];
	const assignedMap = new Map(assigned.map((p) => [p.storageId, p]));

	const visible: Storage[] = [...publicStorages];
	for (const p of assigned) {
		if (!visible.some((s) => s.id === p.storageId)) {
			const s = await getStorageById(db, p.storageId);
			if (s) visible.push(s);
		}
	}

	return Response.json({
		storages: visible.map((s) =>
			storageWithAccess(
				s,
				resolveStorageAccess(user, s, assignedMap.get(s.id) || null),
				false
			)
		),
		isAdmin: false,
		user: user ? toPublicUser(user) : null,
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const method = request.method;

	if (method === "POST") {
		const body = (await request.json()) as Record<string, any>;
		const { action: actionType } = body as { action?: string };

		// 登录（用户表；环境变量管理员自动兼容建号）
		if (actionType === "login") {
			const { username, password } = body as {
				username: string;
				password: string;
			};
			const env = context.cloudflare.env as {
				ADMIN_USERNAME: string;
				ADMIN_PASSWORD: string;
			};
			let userId: number | null = null;
			let role = "user";

			const existingUser = username
				? await getUserByUsername(db, username)
				: null;

			if (existingUser) {
				if (existingUser.isDisabled) {
					return Response.json(
						{ error: "账号已被禁用" },
						{ status: 403 }
					);
				}
				let ok = false;
				if (existingUser.passwordHash) {
					ok = await verifyPassword(password, existingUser.passwordHash);
				} else if (
					existingUser.role === "admin" &&
					(await validateAdmin(username, password, env))
				) {
					// 旧部署：env 管理员还没建号/没设哈希，首次登录固化密码
					await db
						.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
						.bind(await hashPassword(password), existingUser.id)
						.run();
					ok = true;
				}
				if (!ok) {
					await logAudit(db, {
						action: "auth.login_failed",
						userType: "guest",
						ip: meta.ip,
						userAgent: meta.userAgent,
						detail: { username },
					});
					return Response.json(
						{ error: "用户名或密码错误" },
						{ status: 401 }
					);
				}
				userId = existingUser.id;
				role = existingUser.role;
			} else {
				// 没有用户记录：仅当匹配环境管理员时自动建号（老部署平滑迁移）
				const isEnvAdmin = await validateAdmin(username, password, env);
				if (!isEnvAdmin) {
					await logAudit(db, {
						action: "auth.login_failed",
						userType: "guest",
						ip: meta.ip,
						userAgent: meta.userAgent,
						detail: { username },
					});
					return Response.json(
						{ error: "用户名或密码错误" },
						{ status: 401 }
					);
				}
				const created = await db
					.prepare(
						`INSERT INTO users (username, password_hash, role, display_name)
						 VALUES (?, ?, 'admin', '管理员') RETURNING id`
					)
					.bind(username, await hashPassword(password))
					.first<{ id: number }>();
				userId = created?.id ?? null;
				role = "admin";
				if (!userId) {
					return Response.json(
						{ error: "创建管理员账号失败" },
						{ status: 500 }
					);
				}
			}

			const sessionId = await createSession(db, {
				id: userId!,
				role: role as "admin" | "user",
			});
			await logAudit(db, {
				action: "auth.login",
				userType: role as "admin" | "user",
				ip: meta.ip,
				userAgent: meta.userAgent,
				detail: { username },
			});
			return Response.json(
				{ success: true },
				{
					headers: {
						"Set-Cookie": createSessionCookie(sessionId),
					},
				}
			);
		}

		// 退出登录
		if (actionType === "logout") {
			const cookieHeader = request.headers.get("Cookie");
			const sessionId = getSessionIdFromCookie(cookieHeader);
			if (sessionId) {
				await deleteSession(db, sessionId);
			}
			await logAudit(db, {
				action: "auth.logout",
				userType: "admin",
				ip: meta.ip,
				userAgent: meta.userAgent,
			});
			return Response.json(
				{ success: true },
				{
					headers: {
						"Set-Cookie": deleteSessionCookie(),
					},
				}
			);
		}

		// 导出备份（仅管理员）
		if (actionType === "export-backup") {
			const { isAdmin } = await requireAuth(request, db);
			if (!isAdmin) {
				return Response.json({ error: "Unauthorized" }, { status: 403 });
			}

			try {
				const backup = await exportStoragesForBackup(db);
				await logAudit(db, {
					action: "backup.export",
					userType: "admin",
					ip: meta.ip,
					userAgent: meta.userAgent,
					detail: { storages: backup.storages?.length || 0 },
				});
				return Response.json({ backup });
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to export backup",
					},
					{ status: 500 }
				);
			}
		}

		// 导入备份（仅管理员，兼容 CList 备份格式）
		if (actionType === "import-backup") {
			const { isAdmin } = await requireAuth(request, db);
			if (!isAdmin) {
				return Response.json({ error: "Unauthorized" }, { status: 403 });
			}

			const { backup, mode } = body as {
				backup: BackupData;
				mode: "merge" | "replace";
			};

			if (!backup || !backup.storages || !Array.isArray(backup.storages)) {
				return Response.json({ error: "Invalid backup data" }, { status: 400 });
			}

			if (mode !== "merge" && mode !== "replace") {
				return Response.json({ error: "Invalid import mode" }, { status: 400 });
			}

			try {
				const result = await importStoragesFromBackup(db, backup, mode);
				await logAudit(db, {
					action: "backup.import",
					userType: "admin",
					ip: meta.ip,
					userAgent: meta.userAgent,
					detail: {
						mode,
						imported: result.imported,
						skipped: result.skipped,
					},
				});
				return Response.json({ success: true, ...result });
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to import backup",
					},
					{ status: 500 }
				);
			}
		}

		// 新建存储（仅管理员）
		const { isAdmin } = await requireAuth(request, db);
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		try {
			const storage = await createStorage(
				db,
				body as Parameters<typeof createStorage>[1]
			);
			const { saving, ...safeStorage } = storage;
			await logAudit(db, {
				action: "storage.create",
				userType: "admin",
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId: storage.id,
				detail: {
					name: storage.name,
					type: storage.type,
					isPublic: storage.isPublic,
					guestList: storage.guestList,
					guestDownload: storage.guestDownload,
					guestUpload: storage.guestUpload,
				},
			});
			return Response.json({
				storage: { ...safeStorage, secretAccessKey: "***" },
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to create storage",
				},
				{ status: 400 }
			);
		}
	}

	if (method === "PUT") {
		const { isAdmin } = await requireAuth(request, db);
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		const body = (await request.json()) as {
			id: number;
			[key: string]: unknown;
		};

		const { id, ...input } = body;

		try {
			const storage = await updateStorage(db, id, input);
			if (!storage) {
				return Response.json({ error: "Storage not found" }, { status: 404 });
			}
			const { saving, ...safeStorage } = storage;
			await logAudit(db, {
				action: "storage.update",
				userType: "admin",
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId: storage.id,
				detail: {
					name: storage.name,
					type: storage.type,
					isPublic: storage.isPublic,
					guestList: storage.guestList,
					guestDownload: storage.guestDownload,
					guestUpload: storage.guestUpload,
				},
			});
			return Response.json({
				storage: { ...safeStorage, secretAccessKey: "***" },
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to update storage",
				},
				{ status: 400 }
			);
		}
	}

	if (method === "DELETE") {
		const { isAdmin } = await requireAuth(request, db);
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		const url = new URL(request.url);
		const id = parseInt(url.searchParams.get("id") || "0", 10);

		if (!id) {
			return Response.json({ error: "Storage ID required" }, { status: 400 });
		}

		const existing = await getStorageById(db, id);
		if (!existing) {
			return Response.json({ error: "Storage not found" }, { status: 404 });
		}

		// 先记审计再删除：删除后 storage_id 外键已无父行，事后插入会触发约束失败
		await logAudit(db, {
			action: "storage.delete",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			storageId: id,
			detail: { name: existing.name, type: existing.type },
		});

		const deleted = await deleteStorage(db, id);
		if (!deleted) {
			return Response.json({ error: "Storage not found" }, { status: 404 });
		}
		return Response.json({ success: true });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
