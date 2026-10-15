import type { Route } from "./+types/api.me";
import { requireAuth } from "~/lib/auth";
import { initDatabase } from "~/lib/storage";
import { updateUser, toPublicUser } from "~/lib/users";
import { hashPassword, verifyPassword } from "~/lib/password";
import { getRequestMeta, logAudit } from "~/lib/audit";

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const { user } = await requireAuth(request, db);
	if (!user) {
		return Response.json({ user: null }, { status: 401 });
	}
	return Response.json({ user: toPublicUser(user) });
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const { user } = await requireAuth(request, db);
	if (!user) {
		return Response.json({ error: "请先登录" }, { status: 401 });
	}

	const method = request.method;
	if (method !== "PUT" && method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	const body = (await request.json().catch(() => ({}))) as Record<string, any>;
	const actionType = body.action as string | undefined;

	// 修改密码
	if (actionType === "change-password") {
		const { oldPassword, newPassword } = body as {
			oldPassword?: string;
			newPassword?: string;
		};
		if (!newPassword || newPassword.length < 6) {
			return Response.json(
				{ error: "新密码至少 6 位" },
				{ status: 400 }
			);
		}

		// 已有密码：必须验证旧密码
		if (user.passwordHash) {
			if (!oldPassword || !(await verifyPassword(oldPassword, user.passwordHash))) {
				await logAudit(db, {
					action: "auth.password_change_failed",
					userType: user.role,
					ip: meta.ip,
					userAgent: meta.userAgent,
					detail: { userId: user.id },
				});
				return Response.json({ error: "旧密码错误" }, { status: 403 });
			}
		}

		await updateUser(db, user.id, {
			passwordHash: await hashPassword(newPassword),
		});
		await logAudit(db, {
			action: "auth.password_change",
			userType: user.role,
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { userId: user.id },
		});
		return Response.json({ success: true });
	}

	// 修改资料（昵称 / 签名 / 头像）
	const { displayName, bio, avatarUrl } = body as {
		displayName?: string;
		bio?: string;
		avatarUrl?: string;
	};
	if (
		(displayName !== undefined && displayName.length > 64) ||
		(bio !== undefined && bio.length > 200) ||
		(avatarUrl !== undefined && avatarUrl.length > 500)
	) {
		return Response.json({ error: "资料长度超出限制" }, { status: 400 });
	}
	if (avatarUrl && !/^https?:\/\//.test(avatarUrl)) {
		return Response.json({ error: "头像必须是 http(s) 链接" }, { status: 400 });
	}

	const updated = await updateUser(db, user.id, {
		...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
		...(bio !== undefined ? { bio: bio.trim() } : {}),
		...(avatarUrl !== undefined ? { avatarUrl: avatarUrl.trim() } : {}),
	});
	await logAudit(db, {
		action: "user.profile_update",
		userType: user.role,
		ip: meta.ip,
		userAgent: meta.userAgent,
		detail: { userId: user.id },
	});
	return Response.json({ user: updated ? toPublicUser(updated) : null });
}
