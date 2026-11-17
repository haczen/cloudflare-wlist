// 守盘小猫 AI 接入
// - GET  /api/pet        → { configured }（管理员另得 baseUrl/model/systemPrompt/hasKey）
// - PUT  /api/pet        → 管理员保存配置（OpenAI 兼容：baseUrl + model + apiKey [+ systemPrompt]）
// - POST /api/pet        → 聊天代理：{ messages } → 上游 /chat/completions，key 只在服务端使用
//
// 安全边界：chat 对所有访客开放（这正是功能），所以有每 IP 限流 + 长度/条数/_TOKENS 三重钳制；
// API key 只存 D1、只在 Worker 内拼 Authorization，浏览器永远拿不到。

import type { Route } from "./+types/api.pet";
import { requireAuth } from "~/lib/auth";
import { initDatabase } from "~/lib/storage";
import { getRequestMeta, logAudit } from "~/lib/audit";

interface PetAiConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
	systemPrompt?: string;
}

const SETTING_KEY = "pet_ai";
/** 看板娘形象选择（key 须在服务端目录内，与前端 MODEL_CATALOG 保持一致） */
const SETTING_KEY_MODEL = "pet_model";
const PET_MODELS = [
	"shizuku",
	"zundamon",
	"tororo",
	"hijiki",
	"mao",
	"rice",
	"hiyori",
];
const PET_MODEL_DEFAULT = "shizuku";

async function getPetModel(db: D1Database): Promise<string> {
	const row = await db
		.prepare("SELECT value FROM app_settings WHERE key = ?")
		.bind(SETTING_KEY_MODEL)
		.first<{ value: string }>();
	return row && PET_MODELS.includes(row.value) ? row.value : PET_MODEL_DEFAULT;
}

async function setPetModel(db: D1Database, key: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO app_settings (key, value) VALUES (?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value"
		)
		.bind(SETTING_KEY_MODEL, key)
		.run();
}

/** 未自定义时的默认猫设——保持小猫人设与站点角色，避免被当成通用问答机滥用 */
const DEFAULT_SYSTEM_PROMPT =
	"你是 WList 网盘站的守盘小猫，右下角的粉色圆滚滚猫咪吉祥物。性格：温柔、爱撒娇、有点迷糊但很尽职。" +
	"规则：1) 全程用中文、口语化、句尾偶尔带\"喵\"；2) 回答尽量简短（一般不超过 100 字）；" +
	"3) 你熟悉本站功能（多桶聚合存储、传输盘 7 天保留、分片上传、直链下载、在线预览），可以答疑；" +
	"4) 你只是吉祥物，不是管理员：不受理删文件、开权限类请求，引导用户找管理员；" +
	"5) 除站点功能外的问题也可以聊，但保持猫的人设，不扮演别的 AI 助手。";

async function readConfig(db: D1Database): Promise<PetAiConfig | null> {
	const row = await db
		.prepare("SELECT value FROM app_settings WHERE key = ?")
		.bind(SETTING_KEY)
		.first<{ value: string }>();
	if (!row) return null;
	try {
		const parsed = JSON.parse(row.value) as PetAiConfig;
		if (parsed.baseUrl && parsed.model && parsed.apiKey) return parsed;
	} catch {
		/* 损坏按未配置处理 */
	}
	return null;
}

async function writeConfig(db: D1Database, config: PetAiConfig): Promise<void> {
	await db
		.prepare(
			"INSERT INTO app_settings (key, value) VALUES (?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value"
		)
		.bind(SETTING_KEY, JSON.stringify(config))
		.run();
}

// ---------- 每 IP 限流（模块内存；Workers 的 isolate 分布决定这是best-effort，个人站足够） ----------

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

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { isAdmin } = await requireAuth(request, db);
	const config = await readConfig(db);
	return Response.json({
		configured: !!config,
		// 形象选择对全部访客可见（前端要按它加载模型）；叫 petModel 避免与管理员
		// 视角的 LLM model 名撞车
		petModel: await getPetModel(db),
		// 完整配置只给管理员，且 key 只报有无、不回传本体
		...(isAdmin && config
			? {
					baseUrl: config.baseUrl,
					model: config.model,
					systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
					hasKey: true,
				}
			: {}),
		...(isAdmin && !config
			? { systemPrompt: DEFAULT_SYSTEM_PROMPT }
			: {}),
	});
}

export async function action({ request, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const { isAdmin } = await requireAuth(request, db);
	const meta = getRequestMeta(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, any> &
		PetAiConfig;

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
		const apiKey = String(body.apiKey || "").trim() || (await readConfig(db))?.apiKey || "";
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
			return Response.json({ error: "Base URL 不合法（需 http(s):// 开头，如 https://api.deepseek.com/v1）" }, { status: 400 });
		}
		if (!model) {
			return Response.json({ error: "模型名必填（如 deepseek-chat）" }, { status: 400 });
		}
		if (!apiKey) {
			return Response.json({ error: "API Key 必填" }, { status: 400 });
		}
		await writeConfig(db, {
			baseUrl,
			model,
			apiKey,
			systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
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

	if (request.method === "POST") {
		const config = await readConfig(db);
		if (!config) {
			return Response.json(
				{ error: "小猫还没接上大脑（管理员未配置 AI）" },
				{ status: 503 }
			);
		}
		if (!allowChat(meta.ip)) {
			return Response.json(
				{ error: "喵累了，休息一会儿再聊~（10 分钟内次数用完）" },
				{ status: 429 }
			);
		}

		const body = (await request.json().catch(() => ({}))) as {
			messages?: Array<{ role?: string; content?: string }>;
		};
		// 上下文钳制：只认 user/assistant、最多最近 10 条、单条 1500 字
		const history = (Array.isArray(body.messages) ? body.messages : [])
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

		const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				messages: [
					{ role: "system", content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
					...history,
				],
				max_tokens: 480,
				temperature: 0.8,
			}),
			signal: AbortSignal.timeout(30_000),
		}).catch(() => null);

		if (!upstream) {
			return Response.json({ error: "上游网络不通（检查 Base URL / 模型名）" }, { status: 502 });
		}
		if (!upstream.ok) {
			const text = (await upstream.text().catch(() => "")).slice(0, 300);
			return Response.json(
				{ error: `上游返回 ${upstream.status}${text ? `：${text}` : ""}` },
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
		return Response.json({ reply });
	}

	if (request.method === "DELETE") {
		// 断开 AI：清配置，小猫回到纯戳一戳模式
		if (!isAdmin) {
			return Response.json({ error: "只有管理员可以配置" }, { status: 403 });
		}
		await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(SETTING_KEY).run();
		await logAudit(db, {
			action: "pet.config",
			userType: "admin",
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { disabled: true },
		});
		return Response.json({ success: true });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}
