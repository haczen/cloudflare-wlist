// 守盘助手 API
// - GET  /api/pet   → { configured, petModel }（管理员另得 baseUrl/model/systemPrompt/hasKey）
// - PUT  /api/pet   → 管理员保存：{ petModel } 单切形象 / { baseUrl+model+apiKey[+systemPrompt] } 配 AI / 可同带
// - DELETE /api/pet → 管理员断开 AI
// - POST /api/pet   → 聊天代理：{ messages } → 上游 /chat/completions，key 只在服务端使用
//
// 安全边界：chat 对所有访客开放（这正是功能），所以有每 IP 限流 + 长度/条数/token 三重钳制；
// API key 只存 D1、只在 Worker 内拼 Authorization，浏览器永远拿不到。

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

// ---------- 每 IP 限流（模块内存；Workers 的 isolate 分布决定这是 best-effort，个人站足够） ----------

const chatHits = new Map<string, { n: number; reset: number }>();
const CHAT_LIMIT = 15;
const CHAT_WINDOW_MS = 10 * 60_000;

function allowChat(ip: string): boolean {
	const now = Date.now();
	const hit = chatHits.get(ip);
	if (!hit || now > hit.reset) {
		// 顺手清理过期项，防 Map 无界增长
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

// ---------- 聊天总量配额：每个身份（登录用户 / 访客 IP）累计 10 次 ----------

const CHAT_QUOTA = 10;

/** 身份键：登录用户按用户 id，访客按 IP（key 加前缀防碰撞） */
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

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { isAdmin } = await requireAuth(request, db);
	const config = await readPetAiConfig(db);

	// 管理员诊断：?models=1 拉上游可用模型清单（用已存的 key），
	// 解决"模型名填错"这类配置问题——模型 id 以中转方为准，肉眼猜必翻车
	const url = new URL(request.url);
	if (url.searchParams.get("models") === "1") {
		if (!isAdmin) return Response.json({ error: "只有管理员可以查询" }, { status: 403 });
		if (!config) return Response.json({ error: "尚未配置 AI" }, { status: 400 });
		const listAt = (base: string) =>
			fetch(`${base}/models`, {
				headers: { Authorization: `Bearer ${config.apiKey}` },
				signal: AbortSignal.timeout(20_000),
			}).catch(() => null);
		let res = await listAt(config.baseUrl);
		if (
			res &&
			!res.ok &&
			(res.status === 403 || res.status === 404) &&
			!/\/v1$/.test(config.baseUrl)
		) {
			res = (await listAt(`${config.baseUrl}/v1`)) ?? res;
		}
		if (!res) return Response.json({ error: "上游网络不通" }, { status: 502 });
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
		return Response.json({ models, current: config.model });
	}

	// 聊天剩余次数（对当前身份；面板要在下方显示）
	const { user: me } = await requireAuth(request, db);
	const used = await getChatUsage(db, chatIdentity(me, getRequestMeta(request).ip));

	return Response.json({
		configured: !!config,
		remaining: Math.max(0, CHAT_QUOTA - used),
		quota: CHAT_QUOTA,
		// 形象选择对全部访客可见（前端要按它加载模型）；叫 petModel 避免与管理员
		// 视角的 LLM model 名撞车
		petModel: await getPetModel(db),
		// 完整配置只给管理员，且 key 只报有无、不回传本体
		...(isAdmin && config
			? {
					baseUrl: config.baseUrl,
					model: config.model,
					systemPrompt: config.systemPrompt || DEFAULT_PET_SYSTEM_PROMPT,
					hasKey: true,
				}
			: {}),
		...(isAdmin && !config
			? { systemPrompt: DEFAULT_PET_SYSTEM_PROMPT }
			: {}),
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { user, isAdmin } = await requireAuth(request, db);
	const meta = getRequestMeta(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, any> &
		Partial<PetAiConfig> & { petModel?: string };

	if (request.method === "PUT") {
		if (!isAdmin) {
			return Response.json({ error: "只有管理员可以配置" }, { status: 403 });
		}
		// 形象切换：可单独提交（{ petModel }），不触碰 AI 配置
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
			// 没带 AI 字段就到此为止（形象即时生效）
			if (!body.baseUrl && !body.model && !body.apiKey) {
				return Response.json({ success: true });
			}
		}
		const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
		const model = String(body.model || "").trim();
		const systemPrompt = String(body.systemPrompt || "").trim();
		// key 留空 = 沿用旧值（编辑时不必回显明文）
		const apiKey = String(body.apiKey || "").trim() || (await readPetAiConfig(db))?.apiKey || "";
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
		// 断开 AI：清配置，守盘助手回到纯形象模式
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
		const config = await readPetAiConfig(db);
		if (!config) {
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

		// 总量配额：每个身份（登录用户/访客 IP）累计 CHAT_QUOTA 次
		const ident = chatIdentity(user, meta.ip);
		const used = await getChatUsage(db, ident);
		if (used >= CHAT_QUOTA) {
			return Response.json(
				{ error: "聊天次数用完啦~（每个账号共 10 次）", remaining: 0 },
				{ status: 429 }
			);
		}

		// 注意：body 已在 action 顶部解析过一次——Request body 只能读一次，
		// 这里再 request.json() 会抛错被 catch 成空对象 → 消息列表恒空 →
		// 一直报「没有可回复的消息」（此前线上就是这个 bug）
		const chatBody = body as {
			messages?: Array<{ role?: string; content?: string }>;
		};
		// 上下文钳制：只认 user/assistant、最多最近 10 条、单条 1500 字
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

		const payload = JSON.stringify({
			model: config.model,
			messages: [
				{ role: "system", content: config.systemPrompt || DEFAULT_PET_SYSTEM_PROMPT },
				...history,
			],
			max_tokens: 480,
			temperature: 0.8,
		});
		const call = (base: string) =>
			fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: payload,
				signal: AbortSignal.timeout(30_000),
			}).catch(() => null);

		let upstream = await call(config.baseUrl);
		if (!upstream) {
			return Response.json({ error: "上游网络不通（检查 Base URL / 模型名）" }, { status: 502 });
		}
		// OpenAI 兼容配置第一大坑：Base URL 少了 /v1 → 上游 403/404 或怪异报错。
		// 这种情况自动补 /v1 重试一次，用户不必摸索
		if (
			!upstream.ok &&
			(upstream.status === 403 || upstream.status === 404) &&
			!/\/v1$/.test(config.baseUrl)
		) {
			const retry = await call(`${config.baseUrl}/v1`);
			if (retry) upstream = retry;
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
		// 成功回复才计数；返回剩余次数供面板显示
		const n = await bumpChatUsage(db, ident);
		return Response.json({ reply, remaining: Math.max(0, CHAT_QUOTA - n) });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
