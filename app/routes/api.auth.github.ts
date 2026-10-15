import type { Route } from "./+types/api.auth.github";

/** 发起 GitHub OAuth：跳转到授权页 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env as {
		GITHUB_CLIENT_ID?: string;
	};
	const origin = new URL(request.url).origin;

	if (!env.GITHUB_CLIENT_ID) {
		return Response.redirect(
			`${origin}/?github_error=${encodeURIComponent("GitHub 登录未配置")}`,
			302
		);
	}

	const params = new URLSearchParams({
		client_id: env.GITHUB_CLIENT_ID,
		redirect_uri: `${origin}/api/auth/github/callback`,
		scope: "read:user",
	});
	return Response.redirect(
		`https://github.com/login/oauth/authorize?${params}`,
		302
	);
}
