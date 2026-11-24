/**
 * 守盘助手聊天 hook
 * - 聊天记录存 localStorage wlist-pet-chat（最近 30 条）
 * - 发送路径（按优先级）：
 *     ① 浏览器直连「自己接入的模型」（Key 只在本机浏览器里，请求不经过本站服务器）
 *     ② 本站转发 /api/pet（直连连不上/被跨域拦时回退；没接入自己的模型时走这条）
 * - 上下文只带最近 10 条（服务端有同样的钳制）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	loadOwnAi,
	saveOwnAi,
	clearOwnAi,
	directChat,
	directListModels,
	type OwnAiConfig,
} from "~/lib/direct-ai";
import { DEFAULT_PET_SYSTEM_PROMPT } from "~/lib/ai-protocols";

export interface PetChatMessage {
	role: "user" | "assistant";
	content: string;
}

const CHAT_STORAGE_KEY = "wlist-pet-chat";
const CHAT_KEEP = 30;
const HISTORY_KEEP = 10;

type ServerMode = "own" | "site" | null;

export function usePetChat(opts?: { skipProbe?: boolean; reprobeKey?: string | null }) {
	const [aiConfigured, setAiConfigured] = useState(false);
	const [messages, setMessages] = useState<PetChatMessage[]>([]);
	const [waiting, setWaiting] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	/** 守盘助手形象 key（管理员在管理面板切换） */
	const [modelKey, setModelKey] = useState("rice");
	const [probed, setProbed] = useState(false);
	/** 服务端视角的剩余次数 / 模式（-1 = 服务端认为无限） */
	const [serverRemaining, setServerRemaining] = useState<number | null>(null);
	const [serverMode, setServerMode] = useState<ServerMode>(null);
	const [serverModel, setServerModel] = useState<string | null>(null);
	/** 自己接入的模型（存在本机浏览器；null = 没接入） */
	const [ownDirect, setOwnDirect] = useState<OwnAiConfig | null>(null);

	const probe = useCallback(async () => {
		try {
			const r = await fetch("/api/pet");
			if (!r.ok) return;
			const d = (await r.json()) as {
				configured?: boolean;
				petModel?: string;
				remaining?: number;
				myMode?: "own" | "site" | null;
				myModel?: string | null;
			};
			if (!opts?.skipProbe) {
				if (d.configured) setAiConfigured(true);
				if (d.petModel) setModelKey(d.petModel);
			}
			if (typeof d.remaining === "number") setServerRemaining(d.remaining);
			if (d.myMode !== undefined) setServerMode(d.myMode);
			if (d.myModel !== undefined) setServerModel(d.myModel ?? null);
		} catch {
			/* 探测失败按未配置走 */
		} finally {
			setProbed(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		void probe();
		setOwnDirect(loadOwnAi());
		try {
			const saved = localStorage.getItem(CHAT_STORAGE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as PetChatMessage[];
				if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
			}
		} catch {
			/* 损坏忽略 */
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 登录/登出是 SPA 动作不刷新页面，但 loader 数据会变——身份一变就重新探测，
	// 否则登录后聊天面板还停在「登录后才能聊天」直到手动刷新
	const reprobeKey = opts?.reprobeKey;
	const firstKeyRef = useRef(true);
	useEffect(() => {
		if (firstKeyRef.current) {
			firstKeyRef.current = false;
			return;
		}
		void probe();
	}, [reprobeKey, probe]);

	// 记录变化就持久化
	useEffect(() => {
		try {
			if (messages.length === 0) {
				localStorage.removeItem(CHAT_STORAGE_KEY);
				return;
			}
			localStorage.setItem(
				CHAT_STORAGE_KEY,
				JSON.stringify(messages.slice(-CHAT_KEEP))
			);
		} catch {
			/* 隐私模式等场景忽略 */
		}
	}, [messages]);

	/** 已登录（服务端确认过身份）才允许聊天——游客一律不聊，包括直连 */
	const loggedIn = probed && serverMode !== null;
	// 对外的模式与剩余次数：直连优先（无限），否则跟随服务端
	const myMode = loggedIn ? (ownDirect ? "own" : serverMode) : null;
	const remaining = ownDirect && loggedIn ? -1 : serverRemaining;
	const myModel = ownDirect
		? ownDirect.model || "(自动)"
		: serverModel;

	const appendReply = (reply: string) =>
		setMessages((prev) => [...prev, { role: "assistant", content: reply }]);

	/** 走本站转发（服务端决定用自己的还是站内的模型、计不计次数） */
	const sendViaServer = async (history: PetChatMessage[]) => {
		const r = await fetch("/api/pet", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: history }),
		});
		const data = (await r.json().catch(() => ({}))) as {
			reply?: string;
			error?: string;
			remaining?: number;
		};
		if (typeof data.remaining === "number") setServerRemaining(data.remaining);
		if (!r.ok || !data.reply) throw new Error(data.error || "回复失败");
		appendReply(data.reply);
	};

	const sendChat = (text: string): void => {
		const content = text.trim();
		if (!content || waiting) return;
		setChatError(null);
		const history: PetChatMessage[] = [...messages, { role: "user", content }];
		setMessages(history);
		setWaiting(true);
		(async () => {
			// ① 浏览器直连自己接入的模型
			if (ownDirect && loggedIn) {
				let cfg = ownDirect;
				// 没选模型：自动取清单第一个
				if (!cfg.model) {
					const picked = await directListModels(cfg.baseUrl, cfg.apiKey);
					if ("models" in picked && picked.models[0]) {
						cfg = { ...cfg, model: picked.models[0] };
						saveOwnAi(cfg);
						setOwnDirect(cfg);
					}
				}
				if (cfg.model) {
					const out = await directChat(
						cfg,
						DEFAULT_PET_SYSTEM_PROMPT,
						history.slice(-HISTORY_KEEP)
					);
					if ("reply" in out) {
						appendReply(out.reply);
						return;
					}
					if (!out.network) {
						// 接口明确回了错误（Key 错 / 没权限 / 模型不存在…）——直接告诉用户
						setChatError(out.error);
						return;
					}
					// 连不上 / 被跨域拦：回退到本站转发
				}
			}
			// ② 本站转发
			await sendViaServer(history.slice(-HISTORY_KEEP));
		})()
			.catch((err) => {
				setChatError(err instanceof Error ? err.message : "回复失败");
			})
			.finally(() => setWaiting(false));
	};

	/** 「测试并获取模型」：直接从本机浏览器打这个接口 */
	const testOwn = (baseUrl: string, apiKey: string) =>
		directListModels(baseUrl.trim().replace(/\/+$/, ""), apiKey.trim());

	/** 保存自己接入的模型：存本机浏览器（直连用），同时尽力存一份到服务端（直连被拦时回退用） */
	const connectOwn = async (cfg: OwnAiConfig): Promise<OwnAiConfig> => {
		let finalCfg = {
			baseUrl: cfg.baseUrl.trim().replace(/\/+$/, ""),
			apiKey: cfg.apiKey.trim(),
			model: cfg.model.trim(),
		};
		if (!finalCfg.model) {
			const picked = await directListModels(finalCfg.baseUrl, finalCfg.apiKey);
			if ("models" in picked && picked.models[0]) {
				finalCfg = { ...finalCfg, model: picked.models[0] };
			}
		}
		saveOwnAi(finalCfg);
		setOwnDirect(finalCfg);
		try {
			await fetch("/api/pet", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ my: finalCfg }),
			});
		} catch {
			/* 服务端那份只是回退用，失败不影响直连 */
		}
		void probe();
		return finalCfg;
	};

	/** 断开自己接入的模型：本机与服务端两份都清掉 */
	const disconnectOwn = async () => {
		clearOwnAi();
		setOwnDirect(null);
		try {
			await fetch("/api/pet?own=1", { method: "DELETE" });
		} catch {
			/* ignore */
		}
		void probe();
	};

	return {
		aiConfigured,
		messages,
		waiting,
		chatError,
		sendChat,
		modelKey,
		probed,
		remaining,
		myMode,
		myModel,
		ownDirect,
		testOwn,
		connectOwn,
		disconnectOwn,
		/** 保存/断开自己的模型后调用，刷新剩余次数与模式 */
		refresh: () => void probe(),
		clearChat: () => {
			setMessages([]);
			setChatError(null);
		},
	};
}
