// 「接入自己的模型」的浏览器直连：请求从使用者自己的浏览器直接发到 TA 自己的接口，
// 不经过本站服务器。原因很实际——不少中转（hub.oaifree.com 这类）会拒收来自
// Cloudflare Worker 的请求（520）或只允许编程客户端，但从用户电脑直连是通的；
// 本地工具（cc switch 等）能用正是走的这条路。Key 只存在用户自己的浏览器里。
//
// 协议择路 / 应答解析 / 报错翻译全部复用 ai-protocols.ts（与服务端同一套逻辑）。

import {
	buildChatAttempts,
	candidateUrls,
	shouldTryVersioned,
	isApiJson,
	extractReply,
	extractModelIds,
	describeFailures,
	type ChatTurn,
	type AttemptFailure,
} from "./ai-protocols";

export interface OwnAiConfig {
	baseUrl: string;
	apiKey: string;
	/** 留空 = 还没选（发送前自动取清单第一个） */
	model: string;
}

export const OWN_AI_KEY = "wlist-pet-own";

export function loadOwnAi(): OwnAiConfig | null {
	try {
		const raw = localStorage.getItem(OWN_AI_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<OwnAiConfig>;
		if (typeof parsed.baseUrl === "string" && typeof parsed.apiKey === "string") {
			return {
				baseUrl: parsed.baseUrl,
				apiKey: parsed.apiKey,
				model: typeof parsed.model === "string" ? parsed.model : "",
			};
		}
	} catch {
		/* 隐私模式 / 损坏数据：当作没接入 */
	}
	return null;
}

export function saveOwnAi(cfg: OwnAiConfig): void {
	try {
		localStorage.setItem(OWN_AI_KEY, JSON.stringify(cfg));
	} catch {
		/* 存不进去就只在本次会话生效（调用方自己持有内存副本） */
	}
}

export function clearOwnAi(): void {
	try {
		localStorage.removeItem(OWN_AI_KEY);
	} catch {
		/* ignore */
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function browserFetch(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response | null> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		// 地址不通 / 被重置 / 接口不允许浏览器跨域访问（CORS）
		return null;
	}
}

/**
 * 单次请求：先原地址，404/405/403 再补 /v1；52x 原地重试一次。
 * 返回 null = 连不上（含 CORS 被拦）
 */
async function upstream(
	baseUrl: string,
	path: string,
	init: RequestInit
): Promise<Response | null> {
	const urls = candidateUrls(baseUrl, path);
	let last: Response | null = null;
	for (let u = 0; u < urls.length; u++) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await sleep(600);
			const res = await browserFetch(urls[u], init, 45_000);
			if (!res) return last;
			last = res;
			if (res.status >= 520) continue;
			// 裸路径 200 但回的是网站首页（SPA 兜底）——补 /v1 再试
			const looksWrong = res.ok && !(await isApiJson(res));
			if ((shouldTryVersioned(res.status) || looksWrong) && u < urls.length - 1) break;
			return res;
		}
	}
	return last;
}

/** 直连拉模型清单（保存前的「测试并获取模型」） */
export async function directListModels(
	baseUrl: string,
	apiKey: string
): Promise<{ models: string[] } | { error: string }> {
	const res = await upstream(baseUrl, "/models", {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	// 200 但不是 JSON：补了 /v1 还是网页——这个地址不是 API 入口
	if (res?.ok && !(await isApiJson(res))) {
		return {
			error: "这个地址返回的是网页而不是 API 数据：API 地址应填接口入口（一般以 /v1 结尾），而不是网站首页",
		};
	}
	if (!res || !res.ok) {
		return {
			error: describeFailures(
				[{ via: "模型清单", status: res ? res.status : 0 }],
				"browser"
			),
		};
	}
	const data = await res.json().catch(() => null);
	return { models: extractModelIds(data) };
}

export async function directChat(
	cfg: OwnAiConfig,
	systemPrompt: string,
	history: ChatTurn[]
): Promise<{ reply: string } | { error: string; network: boolean }> {
	const tries: AttemptFailure[] = [];
	let gotAnyResponse = false;
	for (const spec of buildChatAttempts(cfg.model, systemPrompt, history)) {
		const res = await upstream(cfg.baseUrl, spec.path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey}`,
				"x-api-key": cfg.apiKey,
				...spec.headers,
			},
			body: JSON.stringify(spec.body),
		});
		if (!res) {
			tries.push({ via: spec.via, status: 0 });
			continue;
		}
		gotAnyResponse = true;
		if (res.ok) {
			if (!(await isApiJson(res))) {
				tries.push({ via: spec.via, status: res.status, text: "返回的是网页而不是 API 数据" });
				continue;
			}
			const data = await res.json().catch(() => null);
			const reply = extractReply(data);
			if (reply) return { reply };
			tries.push({ via: spec.via, status: res.status, text: "回复为空" });
			continue;
		}
		const text = (await res.text().catch(() => "")).slice(0, 200);
		tries.push({ via: spec.via, status: res.status, text });
		if (res.status === 401) break; // Key 不对，换端点也没用
	}
	return {
		error: describeFailures(tries, "browser"),
		network: !gotAnyResponse,
	};
}
