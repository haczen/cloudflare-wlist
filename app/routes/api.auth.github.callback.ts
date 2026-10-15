import type { Route } from "./+types/api.auth.github.callback";
import { initDatabase } from "~/lib/storage";
import { createSession, createSessionCookie } from "~/lib/auth";
import {
	getUserByGithubId,
	createUser,
	updateUser,
	toPublicUser,
} from "~/lib/users";
import { getRequestMeta, logAudit } from "~/lib/audit";

interface GithubUserResponse {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
}

/** GitHub OAuth 回调：换 token → 拉用户信息 → 建会话 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	const env = context.cloudflare.env as {
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
	};
	const meta = getRequestMeta(request);
	const url = new URL(request.url);
	const origin = url.origin;
	const fail = (message: string) =>
		Response.redirect(
			`${origin}/?github_error=${encodeURIComponent(message)}`,
			302
		);

	const code = url.searchParams.get("code");
	if (!code) return fail("GitHub 授权失败：缺少 code");
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return fail("GitHub 登录未配置");
	}

	await initDatabase(db);

	// 换 access_token
	const tokenRes = await fetch(
		"https://github.com/login/oauth/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json",
			},
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${origin}/api/auth/github/callback`,
			}),
		}
	);
	if (!tokenRes.ok) return fail("GitHub 授权失败：无法获取令牌");
	const tokenData = (await tokenRes.json()) as { access_token?: string };
	if (!tokenData.access_token) return fail("GitHub 授权失败：令牌无效");

	// 拉取用户信息
	const userRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "WList",
		},
	});
	if (!userRes.ok) return fail("GitHub 授权失败：无法获取用户信息");
	const gh = (await userRes.json()) as GithubUserResponse;

	// 查找 / 创建用户
	let user = await getUserByGithubId(db, String(gh.id));
	if (!user) {
		// GitHub 用户名冲突时加后缀
		let username = gh.login;
		if (username.length > 60) username = username.slice(0, 60);
		const existing = await db
			.prepare("SELECT id FROM users WHERE username = ?")
			.bind(username)
			.first();
		if (existing) {
			username = `${username}_gh${gh.id}`;
		}
		user = await createUser(db, {
			username,
			displayName: gh.name || gh.login,
			avatarUrl: gh.avatar_url || "",
			role: "user",
			githubId: String(gh.id),
			githubLogin: gh.login,
		});
		await logAudit(db, {
			action: "auth.github_register",
			userType: "user",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { userId: user.id, username: user.username, githubLogin: gh.login },
		});
	} else {
		// 同步最新的 GitHub 头像/昵称（用户没自定义过才覆盖：简单起见每次同步头像）
		await updateUser(db, user.id, {
			avatarUrl: gh.avatar_url || user.avatarUrl,
			githubLogin: gh.login,
		});
		user = (await getUserByGithubId(db, String(gh.id))) || user;
	}

	if (user.isDisabled) {
		return fail("账号已被禁用");
	}

	const sessionId = await createSession(db, user);
	await logAudit(db, {
		action: "auth.github_login",
		userType: user.role,
		ip: meta.ip,
		userAgent: meta.userAgent,
		detail: { userId: user.id, username: user.username },
	});

	const response = Response.redirect(`${origin}/`, 302);
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", createSessionCookie(sessionId));
	return new Response(response.body, {
		status: response.status,
		headers,
	});
}
