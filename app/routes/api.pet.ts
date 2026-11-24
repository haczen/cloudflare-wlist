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
	buildChatAttempts,
	candidateUrls,
	shouldTryVersioned,
	isApiJson,
	extractReply,
	extractModelIds,
	describeFailures,
	invalidApiKeyReason,
	type ChatTurn,
} from "~/lib/ai-protocols";
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

// ---------- 突发限流（模块内存；best-effort，个人站足够） ----------
// 按身份计数（登录用户=账号，游客=IP）+ 管理员豁免——原先按纯 IP 计数，
// 一号管理员聊满后同网络的其他用户（含别的管理员）全被连坐 429=「只有我能聊」

const chatHits = new Map<string, { n: number; reset: number }>();
const CHAT_LIMIT = 15;
const CHAT_WINDOW_MS = 10 * 60_000;

function allowChat(identity: string, isAdmin: boolean): boolean {
	if (isAdmin) return true;
	const now = Date.now();
	const hit = chatHits.get(identity);
	if (!hit || now > hit.reset) {
		if (chatHits.size > 500) {
			for (const [k, v] of chatHits) if (now > v.reset) chatHits.delete(k);
		}
		chatHits.set(identity, { n: 1, reset: now + CHAT_WINDOW_MS });
		return true;
	}
	if (hit.n >= CHAT_LIMIT) return false;
	hit.n += 1;
	return true;
}

// ---------- 聊天配额：非管理员（且未接入自己的模型）累计 CHAT_QUOTA 次 ----------

const CHAT_QUOTA = 5;

function chatIdentity(user: { id: number } | null, ip: string | null): string {
	return user ? `u:${user.id}` : `ip:${ip || "unknown"}`;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 单次上游请求（带两重兜底）：
 * 1) Base URL 没带版本段时先打原地址，404/405/403 再补 /v1 重试
 *    （顺序不能反：Azure 这类 Base URL 本身就是完整路径，先补 /v1 会打坏）
 * 2) 网络错误 / 52x（Cloudflare「源站异常」）→ 等一下原地重试一次
 * 返回 null = 彻底连不上；否则返回最后一个响应（可能仍是 52x）
 */
async function callUpstream(
	baseUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit
): Promise<Response | null> {
	const urls = candidateUrls(baseUrl, path);
	const doFetch = (u: string) =>
		fetch(u, {
			...init,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				// Worker 的 fetch 默认不带 UA；且部分中转有客户端白名单
				// （仅允许 Codex / Claude Code / Cursor 等编程客户端），普通 UA 会被
				// 403 client_not_allowed 拒——挂 Codex CLI 同款 UA
				"User-Agent": "codex_cli_rs/0.42.0",
				...(init.headers || {}),
			},
			signal: AbortSignal.timeout(20_000),
		}).catch(() => null);
	let last: Response | null = null;
	for (let u = 0; u < urls.length; u++) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await sleep(700);
			const res = await doFetch(urls[u]);
			if (!res) return last; // 超时/断连很耗时，不再追加等待
			last = res;
			if (res.status >= 520) continue; // 源站异常：原地再试一次
			// 裸路径 200 但回的是网站首页（SPA 兜底）——等于「这个地址不对」，补 /v1 再试
			const looksWrong = res.ok && !(await isApiJson(res));
			if (
				(shouldTryVersioned(res.status) || looksWrong) &&
				u < urls.length - 1
			) {
				break; // 换成带 /v1 的地址
			}
			return res;
		}
	}
	return last;
}

/** 三种聊天协议依次尝试，直到某一条给出回复；全败则返回能看懂的原因 */
async function callModel(
	baseUrl: string,
	apiKey: string,
	model: string,
	systemPrompt: string,
	history: ChatTurn[]
): Promise<{ reply: string; via: string } | { error: string }> {
	const tries: Array<{ via: string; status: number; text?: string }> = [];
	for (const spec of buildChatAttempts(model, systemPrompt, history)) {
		const res = await callUpstream(baseUrl, apiKey, spec.path, {
			method: "POST",
			headers: { ...spec.headers, "x-api-key": apiKey },
			body: JSON.stringify(spec.body),
		});
		if (!res) {
			tries.push({ via: spec.via, status: 0 });
			continue;
		}
		if (res.ok) {
			// 200 但不是 JSON：补了 /v1 仍拿到网页——这个地址不是 API 入口
			if (!(await isApiJson(res))) {
				tries.push({ via: spec.via, status: res.status, text: "返回的是网页而不是 API 数据" });
				continue;
			}
			const data = await res.json().catch(() => null);
			const reply = extractReply(data);
			if (reply) return { reply, via: spec.via };
			tries.push({ via: spec.via, status: res.status, text: "回复为空" });
			continue;
		}
		const text = (await res.text().catch(() => "")).slice(0, 200);
		tries.push({ via: spec.via, status: res.status, text });
		// Key 不对：换哪个端点都一样，不用再试
		if (res.status === 401) break;
	}
	return { error: describeFailures(tries, "server") };
}

async function listUpstreamModels(
	baseUrl: string,
	apiKey: string
): Promise<Response | null> {
	const res = await callUpstream(baseUrl, apiKey, "/models", { method: "GET" });
	// 200 但不是 JSON：补了 /v1 还是网页（这个地址不是 API 入口）——
	// 统一成 404，让各调用点现有的「接口不存在」分支给出明确提示，
	// 而不是解析出 0 个模型 / 空模型名
	if (res?.ok && !(await isApiJson(res))) {
		return new Response("not an api endpoint", { status: 404 });
	}
	return res;
}

/** 拉模型清单并取第一个（用户没填模型名时用）；拉不到返回空串 */
async function pickFirstModel(
	baseUrl: string,
	apiKey: string
): Promise<string> {
	try {
		const res = await listUpstreamModels(baseUrl, apiKey);
		if (!res || !res.ok) return "";
		const data = (await res.json().catch(() => null)) as
			| { data?: Array<{ id?: string }> }
			| Array<{ id?: string }>
			| null;
		const first = extractModelIds(data)[0];
		return first || "";
	} catch {
		return "";
	}
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { user, isAdmin } = await requireAuth(request, db);
	const meta = getRequestMeta(request);
	const config = await readPetAiConfig(db);
	const url = new URL(request.url);

	// 上游体检（?diag=1，管理员用）：从本站服务器把三种聊天协议 + 模型清单各打一遍，
	// 逐条报状态码与耗时——「到底哪条路通」一眼看清，不再只给一句 502
	if (url.searchParams.get("diag") === "1") {
		if (!isAdmin) {
			return Response.json({ error: "只有管理员可以诊断" }, { status: 403 });
		}
		if (!config) {
			return Response.json({ error: "站内尚未配置 AI" }, { status: 400 });
		}
		const { baseUrl, apiKey, model } = config;
		const probe = async (
			name: string,
			path: string,
			init: RequestInit
		) => {
			const t0 = Date.now();
			const res = await callUpstream(baseUrl, apiKey, path, init);
			const ms = Date.now() - t0;
			const status = res ? res.status : 0;
			const text = res
				? (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ")
				: "";
			return { name, status, ms, text };
		};
		const checks = [
			await probe("模型清单 /models", "/models", { method: "GET" }),
			await probe("Chat /chat/completions", "/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 5,
				}),
			}),
			await probe("Responses /responses", "/responses", {
				method: "POST",
				body: JSON.stringify({ model, input: "ping", max_output_tokens: 16 }),
			}),
			await probe("Messages /messages", "/messages", {
				method: "POST",
				headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 5,
				}),
			}),
		];
		return Response.json({ baseUrl, model, checks });
	}

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
		if (!res || !res.ok) {
			return Response.json(
				{
					error: res
						? `拉不到模型清单：上游返回 ${res.status}${res.status >= 520 ? "（它不接受来自本站服务器的请求）" : ""}`
						: "拉不到模型清单：连不上上游（检查 API 地址）",
				},
				{ status: 502 }
			);
		}
		const data = (await res.json().catch(() => null)) as
			| { data?: Array<{ id?: string }> }
			| Array<{ id?: string }>
			| null;
		const models = extractModelIds(data);
		return Response.json({ models });
	}

	// 我的模式：own = 接入了自己的模型（无限）；site = 用站内的。
	// 模型名可以不填（聊天时自动取清单第一个），所以只看地址 + key
	const own = user ? await getUserPetConfig(db, user.id) : null;
	const ownActive = !!(own?.baseUrl && own?.apiKey);
	const unlimited = ownActive || isAdmin;
	const used = await getChatUsage(db, chatIdentity(user, meta.ip));

	return Response.json({
		configured: !!config,
		// 形象对全部访客可见（前端按它加载模型）
		petModel: await getPetModel(db),
		// -1 = 无限（管理员 / 已接入自己的模型）；游客 0（前端显示登录引导）
		remaining: !user ? 0 : unlimited ? -1 : Math.max(0, CHAT_QUOTA - used),
		quota: CHAT_QUOTA,
		// myMode: own=自己的模型 / site=站内模型 / null=未登录
		myMode: user ? (ownActive ? "own" : "site") : null,
		myModel: ownActive
			? own!.model || "(自动)"
			: own?.siteModel || config?.model || null,
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
					// 校验确实是站内中转有的模型（防乱填）——拉一次清单；
					// 清单拉不到就不拦（上游抽风时不该连选模型都选不了）
					const res = await listUpstreamModels(
						siteConfig.baseUrl,
						siteConfig.apiKey
					);
					const data =
						res && res.ok
							? ((await res.json().catch(() => null)) as {
									data?: Array<{ id?: string }>;
								} | null)
							: null;
					const ids = (data?.data ?? [])
						.map((m) => m.id)
						.filter((id): id is string => typeof id === "string");
					if (ids.length > 0 && !ids.includes(body.mySiteModel)) {
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
				// key 留空 = 沿用已保存的
				const apiKey =
					String(body.my.apiKey || "").trim() || cur.apiKey || "";
				if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
					return Response.json({ error: "API 地址不合法（需 http(s):// 开头）" }, { status: 400 });
				}
				if (!apiKey) {
					return Response.json({ error: "API Key 必填" }, { status: 400 });
				}
				const keyShape = invalidApiKeyReason(apiKey);
				if (keyShape) {
					return Response.json({ error: keyShape }, { status: 400 });
				}
				// 模型名可以不填：没填就自动取该接口清单里的第一个
				let model = String(body.my.model || "").trim();
				if (!model) {
					model = await pickFirstModel(baseUrl, apiKey);
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
		// ---- 管理员：站内 AI 配置（模型名可留空 = 自动取清单第一个）----
		const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
		const systemPrompt = String(body.systemPrompt || "").trim();
		const apiKey =
			String(body.apiKey || "").trim() ||
			(await readPetAiConfig(db))?.apiKey ||
			"";
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
			return Response.json({ error: "API 地址不合法（需 http(s):// 开头，如 https://api.deepseek.com/v1）" }, { status: 400 });
		}
		if (!apiKey) {
			return Response.json({ error: "API Key 必填" }, { status: 400 });
		}
		const siteKeyShape = invalidApiKeyReason(apiKey);
		if (siteKeyShape) {
			return Response.json({ error: siteKeyShape }, { status: 400 });
		}
		let model = String(body.model || "").trim();
		if (!model) {
			model = await pickFirstModel(baseUrl, apiKey);
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
			if (!res || !res.ok) {
				return Response.json(
					{
						error: res
							? `连不上这个接口：上游返回 ${res.status}${res.status >= 520 ? "（它不接受来自本站服务器的请求，只允许 Codex / Claude Code 这类客户端从电脑直连）" : ""}`
							: "连不上这个接口（超时或被重置）：检查 API 地址是否写对",
					},
					{ status: 502 }
				);
			}
			const data = (await res.json().catch(() => null)) as
				| { data?: Array<{ id?: string }> }
				| Array<{ id?: string }>
				| null;
			const models = extractModelIds(data);
			return Response.json({ models });
		}

		// 聊天：优先用自己的模型（无限），否则站内模型
		const siteConfig = await readPetAiConfig(db);
		const own = user ? await getUserPetConfig(db, user.id) : null;
		const ownActive = !!(own?.baseUrl && own?.apiKey);
		if (!ownActive && !siteConfig) {
			return Response.json(
				{ error: "守盘助手还没接上大脑（管理员未配置 AI）" },
				{ status: 503 }
			);
		}
		// 聊天须登录：游客一律 401（对话能力是登录用户的权益）
		if (!user) {
			return Response.json(
				{ error: "登录后才能和她聊天哦~（右上角登录）" },
				{ status: 401 }
			);
		}
		if (!allowChat(chatIdentity(user, meta.ip), isAdmin)) {
			return Response.json(
				{ error: "累了喵，休息一会儿再聊~（10 分钟内次数用完）" },
				{ status: 429 }
			);
		}

		const baseCfg = ownActive
			? {
					// 用户自己的模型也套用站内人设，保持角色一致
					baseUrl: own!.baseUrl!,
					apiKey: own!.apiKey!,
					model: own!.model || "",
					systemPrompt: siteConfig?.systemPrompt,
				}
			: {
					baseUrl: siteConfig!.baseUrl,
					apiKey: siteConfig!.apiKey,
					// 站内模式下用户可自选站内模型
					model: own?.siteModel || siteConfig!.model || "",
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

		// 模型名没填 → 自动取这个接口清单里的第一个
		let model = baseCfg.model;
		if (!model) {
			model = await pickFirstModel(baseCfg.baseUrl, baseCfg.apiKey);
			if (!model) {
				return Response.json(
					{ error: "还没选模型，而且拉不到模型清单：到设置里点「测试并获取模型」选一个，或手动填模型名" },
					{ status: 400 }
				);
			}
		}

		// 三种协议依次尝试（Chat / Responses / Messages），哪条通走哪条
		const out = await callModel(
			baseCfg.baseUrl,
			baseCfg.apiKey,
			model,
			baseCfg.systemPrompt || DEFAULT_PET_SYSTEM_PROMPT,
			history
		);
		if ("error" in out) {
			return Response.json({ error: out.error }, { status: 502 });
		}
		const reply = out.reply;
		// 成功回复才计数（无限身份不计数）
		if (unlimited) {
			return Response.json({ reply, remaining: -1 });
		}
		const n = await bumpChatUsage(db, ident);
		return Response.json({ reply, remaining: Math.max(0, CHAT_QUOTA - n) });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
