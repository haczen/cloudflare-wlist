import { createRequestHandler, type AppLoadContext } from "react-router";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const getServerBuild = () => import("virtual:react-router/server-build");

const requestHandler = createRequestHandler(getServerBuild, import.meta.env.MODE);

async function handleWebdavRequest(
	request: Request,
	params: { storageId: string; "*": string },
	context: AppLoadContext
): Promise<Response> {
	const build = await getServerBuild();
	const route = build.routes["routes/dav.$storageId.$"];
	const module = route?.module as
		| {
				handleWebdavRequest?: (
					request: Request,
					params: { storageId: string; "*": string },
					context: AppLoadContext
				) => Promise<Response>;
		  }
		| undefined;
	const handler = module?.handleWebdavRequest;
	if (typeof handler !== "function") {
		return new Response("WebDAV handler not found", { status: 500 });
	}
	return handler(request, params, context);
}

function getWebdavParams(request: Request): { storageId: string; "*": string } | null {
	const url = new URL(request.url);
	const match = url.pathname.match(/^\/dav\/([^/]+)\/?(.*)$/);
	if (!match) {
		return null;
	}
	const rawPath = match[2] || "";
	// 逐段解码，避免整段 decodeURIComponent 把 %2F 当成分隔符；非法序列保留原文
	const decodedPath = rawPath
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/");

	return {
		storageId: match[1],
		"*": decodedPath,
	};
}

export default {
	async fetch(request, env, ctx) {
		const webdavParams = getWebdavParams(request);
		if (webdavParams) {
			return handleWebdavRequest(request, webdavParams, {
				cloudflare: { env, ctx },
			});
		}

		return requestHandler(request, {
			cloudflare: { env, ctx },
		});
	},

	// 每日 Cron 兜底：清理传输盘超期（7 天）文件（访问时的惰性清理为主力）
	async scheduled(_event, env, _ctx) {
		const db = (env as Env).DB;
		if (!db) return;
		const { initDatabase } = await import("~/lib/storage");
		const { cleanExpiredPoolFiles } = await import("~/lib/pool");
		await initDatabase(db);
		const deleted = await cleanExpiredPoolFiles(db);
		console.log(`[cron] pool retention cleanup: ${deleted} file(s) removed`);
	},
} satisfies ExportedHandler<Env>;
