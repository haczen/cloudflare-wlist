// 守盘助手 API
// - GET  /api/pet              → { configured, petModel, remaining(-1=无限), myMode, myModel }
//   ?models=1    → 登录用户可拉站内中转的可用模型清单（用站内 key）
//   ?models=1&own=1 → 用自己已保存的 key 拉自己的模型清单
// - PUT  /api/pet
//   { petModel }                          管理员：切形象
//   { baseUrl, model, apiKey?[, systemPrompt?] } 管理员：站内 AI 配置（人设只有管理员能改）
//   { mySiteModel }                       登录用户：选站内模型
//   { my: { baseUrl, model, apiKey? } }   登录用户：接入自己的模型（无限畅聊）
// - DELETE /api/pet            管理员：断开站内 AI；?own=1 登录用户：断开自己的模型
// - POST /api/pet              聊天代理：优先用用户自己的模型（无限），否则站内模型
//   （管理员无限；其他身份共 CHAT_QUOTA 次）
//
// 安全边界：所有 key 只存 D1、只在 Worker 内拼 Authorization；聊天有每 IP 频控 +
// 非 BYOK 身份的总量配额，防薅站内 key。

import type { Route } from "./+types/api.pet";
import { requireAuth } from "~/lib/auth";
import { initDatabase } from "~/lib/storage";
import { getRequestMeta, logAudit } from "~/lib/audit";
import {
	DEFAULT_PET_SYSTEM_PROMPT,
	PET_MODELS,
	getPetModel,
	setPetModel,
	readPetAiConfig,
	writePetAiConfig,
	deletePetAiConfig,
	type PetAiConfig,
} from "~/lib/pet";

/** 用户自接模型（BYOK）配置 */
interface UserPetConfig {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	/** 站内模式下选用的站内模型 id（空 = 跟随管理员当前配置） */
	siteModel?: string;
}

// ---------- 每 IP 频控（模块内存；best-effort，个人站足够） ----------

const chatHits = new Map<string, { n: number; reset: number }>();
const CHAT_LIMIT = 15;
const CHAT_WINDOW_MS = 10 * 60_000;

function allowChat(ip: string): boolean {
	const now = Date.now();
	const hit = chatHits.get(ip);
	if (!hit || now > hit.reset) {
		if (chatHits.size > 500) {
			for (const [k, v] of chatHits) if (now > v.reset) chatHits.delete(k);
		}
		chatHits.set(ip, { n: 1, reset: now + CHAT_WINDOW_MS });
		return true;
	}
	if (hit.n >= CHAT_LIMIT) return false;
	hit.n += 1;
	return true;
}

// ---------- 聊天配额：非管理员（且未接入自己的模型）累计 CHAT_QUOTA 次 ----------

const CHAT_QUOTA = 5;

function chatIdentity(user: { id: number } | null, ip: string): string {
	return user ? `u:${user.id}` : `ip:${ip}`;
}

async function getChatUsage(db: D1Database, key: string): Promise<number> {
	const row = await db
		.prepare("SELECT n FROM pet_chat_usage WHERE k = ?")
		.bind(key)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function bumpChatUsage(db: D1Database, key: string): Promise<number> {
	await db
		.prepare(
			"INSERT INTO pet_chat_usage (k, n) VALUES (?, 1) " +
				"ON CONFLICT(k) DO UPDATE SET n = n + 1"
		)
		.bind(key)
		.run();
	return getChatUsage(db, key);
}

// ---------- 用户自接模型（BYOK）存取 ----------

async function getUserPetConfig(
	db: D1Database,
	userId: number
): Promise<UserPetConfig | null> {
	const row = await db
		.prepare("SELECT json FROM pet_user_config WHERE user_id = ?")
		.bind(userId)
		.first<{ json: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.json) as UserPetConfig;
	} catch {
		return null;
	}
}

async function setUserPetConfig(
	db: D1Database,
	userId: number,
	cfg: UserPetConfig
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO pet_user_config (user_id, json) VALUES (?, ?) " +
				"ON CONFLICT(user_id) DO UPDATE SET json = excluded.json"
		)
		.bind(userId, JSON.stringify(cfg))
		.run();
}

async function deleteUserPetConfig(
	db: D1Database,
	userId: number
): Promise<void> {
	await db
		.prepare("DELETE FROM pet_user_config WHERE user_id = ?")
		.bind(userId)
		.run();
}

/** OpenAI 兼容端点兜底：Base URL 少 /v1 → 403/404 时自动补试一次 */
async function callUpstream(
	baseUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit
): Promise<Response | null> {
	const doFetch = (b: string) =>
		fetch(`${b}${path}`, {
			...init,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				...(init.headers || {}),
			},
			signal: AbortSignal.timeout(30_000),
		}).catch(() => null);
	let res = await doFetch(baseUrl);
	if (
		res &&
		!res.ok &&
		(res.status === 403 || res.status === 404) &&
		!/\/v\d+$/.test(baseUrl)
	) {
		const retry = await doFetch(`${baseUrl}/v1`);
		if (retry) res = retry;
	}
	return res;
}

async function listUpstreamModels(
	baseUrl: string,
	apiKey: string
): Promise<Response> {
	return (
		(await callUpstream(baseUrl, apiKey, "/models", { method: "GET" })) ??
		new Response("upstream unreachable", { status: 502 })
	);
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { user, isAdmin } = await requireAuth(request, db);
	const meta = getRequestMeta(request);
	const config = await readPetAiConfig(db);
	const url = new URL(request.url);

	// 可用模型清单：?models=1 站内（登录用户可用）；&own=1 用自己保存的 key
	if (url.searchParams.get("models") === "1") {
		let baseUrl: string;
		let apiKey: string;
		if (url.searchParams.get("own") === "1") {
			if (!user) {
				return Response.json({ error: "请先登录" }, { status: 401 });
			}
			const own = await getUserPetConfig(db, user.id);
			if (!own?.baseUrl || !own?.apiKey) {
				return Response.json({ error: "尚未接入自己的模型" }, { status: 400 });
			}
			baseUrl = own.baseUrl;
			apiKey = own.apiKey;
		} else {
			if (!user) {
				return Response.json({ error: "请先登录" }, { status: 401 });
			}
			if (!config) {
				return Response.json({ error: "站内尚未配置 AI" }, { status: 400 });
			}
			baseUrl = config.baseUrl;
			apiKey = config.apiKey;
		}
		const res = await listUpstreamModels(baseUrl, apiKey);
		if (!res.ok) {
			return Response.json(
				{ error: `上游返回 ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}` },
				{ status: 502 }
			);
		}
		const data = (await res.json().catch(() => null)) as
			| { data?: Array<{ id?: string }> }
			| null;
		const models = (data?.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => typeof id === "string");
		return Response.json({ models });
	}

	// 我的模式：own = 接入了自己的模型（无限）；site = 用站内的
	const own = user ? await getUserPetConfig(db, user.id) : null;
	const ownActive = !!(own?.baseUrl && own?.apiKey && own?.model);
	const unlimited = ownActive || isAdmin;
	const used = await getChatUsage(db, chatIdentity(user, meta.ip));

	return Response.json({
		configured: !!config,
		// 形象对全部访客可见（前端按它加载模型）
		petModel: await getPetModel(db),
		// -1 = 无限畅聊（管理员 / 已接入自己的模型）
		remaining: unlimited ? -1 : Math.max(0, CHAT_QUOTA - used),
		quota: CHAT_QUOTA,
		// myMode: own=自己的模型 / site=站内模型 / null=未登录
		myMode: user ? (ownActive ? "own" : "site") : null,
		myModel: ownActive ? own!.model : own?.siteModel || config?.model || null,
		// 完整站内配置只给管理员（人设提示词只有管理员能看）
		...(isAdmin && config
			? {
					baseUrl: config.baseUrl,
					model: config.model,
					systemPrompt: config.systemPrompt || DEFAULT_PET_SYSTEM_PROMPT,
					hasKey: true,
				}
			: {}),
		...(isAdmin && !config ? { systemPrompt: DEFAULT_PET_SYSTEM_PROMPT } : {}),
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { user, isAdmin } = await requireAuth(request, db);
	const meta = getRequestMeta(request);
	const url = new URL(request.url);
	const body = (await request.json().catch(() => ({}))) as Record<string, any> &
		Partial<PetAiConfig> & {
			petModel?: string;
			mySiteModel?: string;
			my?: { baseUrl?: string; apiKey?: string; model?: string };
			models?: { baseUrl?: string; apiKey?: string };
		};

	if (request.method === "PUT") {
		// ---- 用户自接模型 / 选站内模型（登录即可，不需要管理员）----
		if (body.my !== undefined || body.mySiteModel !== undefined) {
			if (!user) {
				return Response.json({ error: "请先登录" }, { status: 401 });
			}
			const cur = (await getUserPetConfig(db, user.id)) || {};
			if (typeof body.mySiteModel === "string") {
				// 选站内模型：空串 = 跟随管理员当前配置
				const siteConfig = await readPetAiConfig(db);
				if (
					body.mySiteModel &&
					siteConfig &&
					body.mySiteModel !== siteConfig.model
				) {
					// 校验确实是站内中转有的模型（防乱填）——拉一次清单
					const res = await listUpstreamModels(
						siteConfig.baseUrl,
						siteConfig.apiKey
					);
					const data = res.ok
						? ((await res.json().catch(() => null)) as {
								data?: Array<{ id?: string }>;
							} | null)
						: null;
					const ids = (data?.data ?? [])
						.map((m) => m.id)
						.filter((id): id is string => typeof id === "string");
					if (!ids.includes(body.mySiteModel)) {
						return Response.json({ error: "站内没有这个模型" }, { status: 400 });
					}
				}
				await setUserPetConfig(db, user.id, {
					...cur,
					siteModel: body.mySiteModel || undefined,
				});
				return Response.json({ success: true });
			}
			if (body.my) {
				const baseUrl = String(body.my.baseUrl || "").trim().replace(/\/+$/, "");
				const model = String(body.my.model || "").trim();
				// key 留空 = 沿用已保存的
				const apiKey =
					String(body.my.apiKey || "").trim() || cur.apiKey || "";
				if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
					return Response.json({ error: "Base URL 不合法（需 http(s):// 开头，一般以 /v1 结尾）" }, { status: 400 });
				}
				if (!model) {
					return Response.json({ error: "模型名必填（可用下方按钮拉取清单）" }, { status: 400 });
				}
				if (!apiKey) {
					return Response.json({ error: "API Key 必填" }, { status: 400 });
				}
				await setUserPetConfig(db, user.id, {
					...cur,
					baseUrl,
					apiKey,
					model,
				});
				await logAudit(db, {
					action: "pet.own_config",
					userType: isAdmin ? "admin" : "user",
					ip: meta.ip,
					userAgent: meta.userAgent,
					detail: { baseUrl, model },
				});
				return Response.json({ success: true });
			}
		}

		if (!isAdmin) {
			return Response.json({ error: "只有管理员可以配置站内 AI" }, { status: 403 });
		}
		// ---- 管理员：切形象（可单独提交）----
		if (typeof body.petModel === "string") {
			if (!PET_MODELS.includes(body.petModel)) {
				return Response.json({ error: "未知形象" }, { status: 400 });
			}
			await setPetModel(db, body.petModel);
			await logAudit(db, {
				action: "pet.config",
				userType: "admin",
				ip: meta.ip,
				userAgent: meta.userAgent,
				detail: { petModel: body.petModel },
			});
			if (!body.baseUrl && !body.model && !body.apiKey) {
				return Response.json({ success: true });
			}
		}
		// ---- 管理员：站内 AI 配置 ----
		const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
		const model = String(body.model || "").trim();
		const systemPrompt = String(body.systemPrompt || "").trim();
		const apiKey =
			String(body.apiKey || "").trim() ||
			(await readPetAiConfig(db))?.apiKey ||
			"";
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
			return Response.json({ error: "Base URL 不合法（需 http(s):// 开头，如 https://api.deepseek.com/v1）" }, { status: 400 });
		}
		if (!model) {
			return Response.json({ error: "模型名必填（如 deepseek-chat）" }, { status: 400 });
		}
		if (!apiKey) {
			return Response.json({ error: "API Key 必填" }, { status: 400 });
		}
		await writePetAiConfig(db, {
			baseUrl,
			model,
			apiKey,
			systemPrompt: systemPrompt || DEFAULT_PET_SYSTEM_PROMPT,
		});
		await logAudit(db, {
			action: "pet.config",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { baseUrl, model },
		});
		return Response.json({ success: true });
	}

	if (request.method === "DELETE") {
		// ?own=1：登录用户断开自己的模型
		if (url.searchParams.get("own") === "1") {
			if (!user) {
				return Response.json({ error: "请先登录" }, { status: 401 });
			}
			await deleteUserPetConfig(db, user.id);
			return Response.json({ success: true });
		}
		if (!isAdmin) {
			return Response.json({ error: "只有管理员可以配置" }, { status: 403 });
		}
		await deletePetAiConfig(db);
		await logAudit(db, {
			action: "pet.config",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { disabled: true },
		});
		return Response.json({ success: true });
	}

	if (request.method === "POST") {
		// POST ?models=1：用「填了还没保存」的 key 试拉清单（接入前的体检）
		if (url.searchParams.get("models") === "1") {
			if (!user) {
				return Response.json({ error: "请先登录" }, { status: 401 });
			}
			const baseUrl = String(body.models?.baseUrl || "").trim().replace(/\/+$/, "");
			const apiKey = String(body.models?.apiKey || "").trim();
			if (!/^https?:\/\//.test(baseUrl) || !apiKey) {
				return Response.json({ error: "先填 Base URL 和 API Key" }, { status: 400 });
			}
			const res = await listUpstreamModels(baseUrl, apiKey);
			if (!res.ok) {
				return Response.json(
					{ error: `上游返回 ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}` },
					{ status: 502 }
				);
			}
			const data = (await res.json().catch(() => null)) as
				| { data?: Array<{ id?: string }> }
				| null;
			const models = (data?.data ?? [])
				.map((m) => m.id)
				.filter((id): id is string => typeof id === "string");
			return Response.json({ models });
		}

		// 聊天：优先用自己的模型（无限），否则站内模型
		const siteConfig = await readPetAiConfig(db);
		const own = user ? await getUserPetConfig(db, user.id) : null;
		const ownActive = !!(own?.baseUrl && own?.apiKey && own?.model);
		if (!ownActive && !siteConfig) {
			return Response.json(
				{ error: "守盘助手还没接上大脑（管理员未配置 AI）" },
				{ status: 503 }
			);
		}
		if (!allowChat(meta.ip)) {
			return Response.json(
				{ error: "累了喵，休息一会儿再聊~（10 分钟内次数用完）" },
				{ status: 429 }
			);
		}

		const cfg = ownActive
			? {
					baseUrl: own!.baseUrl!,
					apiKey: own!.apiKey!,
					model: own!.model!,
					// 用户自己的模型也套用站内人设，保持角色一致
					systemPrompt: siteConfig?.systemPrompt,
				}
			: {
					baseUrl: siteConfig!.baseUrl,
					apiKey: siteConfig!.apiKey,
					// 站内模式下用户可自选站内模型
					model: own?.siteModel || siteConfig!.model,
					systemPrompt: siteConfig!.systemPrompt,
				};
		const unlimited = ownActive || isAdmin;
		const ident = chatIdentity(user, meta.ip);
		if (!unlimited) {
			const used = await getChatUsage(db, ident);
			if (used >= CHAT_QUOTA) {
				return Response.json(
					{
						error: `聊天次数用完啦~（共 ${CHAT_QUOTA} 次；接入自己的模型可无限畅聊）`,
						remaining: 0,
					},
					{ status: 429 }
				);
			}
		}

		const chatBody = body as {
			messages?: Array<{ role?: string; content?: string }>;
		};
		const history = (Array.isArray(chatBody.messages) ? chatBody.messages : [])
			.filter(
				(m): m is { role: "user" | "assistant"; content: string } =>
					(m.role === "user" || m.role === "assistant") &&
					typeof m.content === "string" &&
					m.content.trim() !== ""
			)
			.slice(-10)
			.map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
		if (history.length === 0 || history[history.length - 1].role !== "user") {
			return Response.json({ error: "没有可回复的消息" }, { status: 400 });
		}

		const upstream = await callUpstream(cfg.baseUrl, cfg.apiKey, "/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: cfg.model,
				messages: [
					{
						role: "system",
						content: cfg.systemPrompt || DEFAULT_PET_SYSTEM_PROMPT,
					},
					...history,
				],
				max_tokens: 480,
				temperature: 0.8,
			}),
		});
		if (!upstream) {
			return Response.json({ error: "上游网络不通（检查 Base URL / 模型名）" }, { status: 502 });
		}
		if (!upstream.ok) {
			const text = (await upstream.text().catch(() => "")).slice(0, 300);
			const hint =
				upstream.status === 404
					? "（模型名或路径不对：确认模型 id 与 Base URL 是否以 /v1 结尾）"
					: upstream.status === 401
						? "（API Key 无效或已过期）"
						: "";
			return Response.json(
				{ error: `上游返回 ${upstream.status}${hint}${text ? `：${text}` : ""}` },
				{ status: 502 }
			);
		}
		const data = (await upstream.json().catch(() => null)) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const reply = data?.choices?.[0]?.message?.content?.trim();
		if (!reply) {
			return Response.json({ error: "上游没说话（回复为空）" }, { status: 502 });
		}
		// 成功回复才计数（无限身份不计数）
		if (unlimited) {
			return Response.json({ reply, remaining: -1 });
		}
		const n = await bumpChatUsage(db, ident);
		return Response.json({ reply, remaining: Math.max(0, CHAT_QUOTA - n) });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
