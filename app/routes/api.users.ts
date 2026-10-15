import type { Route } from "./+types/api.users";
import { requireAuth } from "~/lib/auth";
import { initDatabase } from "~/lib/storage";
import {
	getAllUsers,
	getUserById,
	createUser,
	updateUser,
	deleteUser,
	toPublicUser,
	type UserRole,
} from "~/lib/users";
import {
	getUserFolders,
	setUserFolders,
	type UserFolderPerm,
} from "~/lib/folders";
import { hashPassword } from "~/lib/password";
import { getRequestMeta, logAudit } from "~/lib/audit";

/** 仅管理员 */
async function requireAdmin(request: Request, db: D1Database) {
	const { user, isAdmin } = await requireAuth(request, db);
	if (!isAdmin || !user) {
		return null;
	}
	return user;
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const me = await requireAdmin(request, db);
	if (!me) {
		return Response.json({ error: "Unauthorized" }, { status: 403 });
	}

	const users = await getAllUsers(db);
	const withFolders = await Promise.all(
		users.map(async (u) => ({
			...toPublicUser(u),
			hasPassword: !!u.passwordHash,
			folders: await getUserFolders(db, u.id),
		}))
	);
	return Response.json({ users: withFolders });
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const me = await requireAdmin(request, db);
	if (!me) {
		return Response.json({ error: "Unauthorized" }, { status: 403 });
	}

	const method = request.method;
	const url = new URL(request.url);
	const body = (await request.json().catch(() => ({}))) as Record<string, any>;

	// 新建用户
	if (method === "POST") {
		const { username, password, role, folders } = body as {
			username?: string;
			password?: string;
			role?: UserRole;
			folders?: UserFolderPerm[];
		};
		if (!username || !password || password.length < 6) {
			return Response.json(
				{ error: "用户名必填，密码至少 6 位" },
				{ status: 400 }
			);
		}
		try {
			// 先校验分配的目录都存在，避免建号成功但分配失败留下半成品
			if (Array.isArray(folders) && folders.length > 0) {
				for (const p of folders) {
					const exists = await db
						.prepare("SELECT id FROM folders WHERE id = ?")
						.bind(p.folderId)
						.first();
					if (!exists) {
						return Response.json(
							{ error: `目录 ${p.folderId} 不存在` },
							{ status: 400 }
						);
					}
				}
			}
			const user = await createUser(db, {
				username,
				passwordHash: await hashPassword(password),
				role: role === "admin" ? "admin" : "user",
				displayName: username,
			});
			if (Array.isArray(folders)) {
				try {
					await setUserFolders(db, user.id, folders);
				} catch (assignErr) {
					// 分配失败则回滚已建用户
					await deleteUser(db, user.id);
					throw assignErr;
				}
			}
			await logAudit(db, {
				action: "user.create",
				userType: "admin",
				ip: meta.ip,
				userAgent: meta.userAgent,
				detail: {
					userId: user.id,
					username: user.username,
					role: user.role,
					folders: Array.isArray(folders) ? folders.length : 0,
				},
			});
			return Response.json({ user: toPublicUser(user) });
		} catch (err) {
			return Response.json(
				{ error: err instanceof Error ? err.message : "创建失败" },
				{ status: 400 }
			);
		}
	}

	// 更新用户（资料/角色/禁用/重置密码/分配存储）
	if (method === "PUT") {
		const id = body.id as number | undefined;
		if (!id) {
			return Response.json({ error: "id 必填" }, { status: 400 });
		}
		const target = await getUserById(db, id);
		if (!target) {
			return Response.json({ error: "用户不存在" }, { status: 404 });
		}

		// 防御：不能禁用/降级自己
		if (target.id === me.id) {
			if (body.isDisabled === true) {
				return Response.json(
					{ error: "不能禁用自己" },
					{ status: 400 }
				);
			}
			if (body.role === "user") {
				return Response.json(
					{ error: "不能降级自己" },
					{ status: 400 }
				);
			}
		}

		const input: Parameters<typeof updateUser>[2] = {};
		if (typeof body.displayName === "string") input.displayName = body.displayName;
		if (typeof body.bio === "string") input.bio = body.bio;
		if (typeof body.avatarUrl === "string") input.avatarUrl = body.avatarUrl;
		if (body.role === "admin" || body.role === "user") input.role = body.role;
		if (typeof body.isDisabled === "boolean") input.isDisabled = body.isDisabled;
		if (typeof body.password === "string" && body.password) {
			if (body.password.length < 6) {
				return Response.json({ error: "密码至少 6 位" }, { status: 400 });
			}
			input.passwordHash = await hashPassword(body.password);
		}

		const updated = await updateUser(db, id, input);

		if (Array.isArray(body.folders)) {
			const perms = (body.folders as UserFolderPerm[]).filter(
				(p) => p && typeof p.folderId === "number"
			);
			await setUserFolders(db, id, perms);
		}

		await logAudit(db, {
			action: "user.update",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: {
				userId: id,
				role: input.role,
				isDisabled: input.isDisabled,
				resetPassword: !!input.passwordHash,
				foldersAssigned: Array.isArray(body.folders),
			},
		});
		return Response.json({
			user: updated ? toPublicUser(updated) : null,
			folders: await getUserFolders(db, id),
		});
	}

	// 删除用户
	if (method === "DELETE") {
		const id = parseInt(url.searchParams.get("id") || "0", 10);
		if (!id) {
			return Response.json({ error: "id 必填" }, { status: 400 });
		}
		if (id === me.id) {
			return Response.json({ error: "不能删除自己" }, { status: 400 });
		}
		const target = await getUserById(db, id);
		if (!target) {
			return Response.json({ error: "用户不存在" }, { status: 404 });
		}
		await deleteUser(db, id);
		// 顺带清掉该用户的会话
		await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
		await logAudit(db, {
			action: "user.delete",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { userId: id, username: target.username },
		});
		return Response.json({ success: true });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
