/**
 * 守盘看板娘 / 小猫共用的 AI 聊天 hook
 * - 挂载后探测 /api/pet 是否已配置（管理员接入了 LLM）
 * - 聊天记录存 localStorage wlist-pet-chat（最近 30 条，随设备不迁移）
 * - 发送：上下文只带最近 10 条（服务端有同样的钳制）
 */
import { useCallback, useEffect, useState } from "react";

export interface PetChatMessage {
	role: "user" | "assistant";
	content: string;
}

const CHAT_STORAGE_KEY = "wlist-pet-chat";
const CHAT_KEEP = 30;

export function usePetChat(opts?: { skipProbe?: boolean }) {
	const [aiConfigured, setAiConfigured] = useState(false);
	const [messages, setMessages] = useState<PetChatMessage[]>([]);
	const [waiting, setWaiting] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	/** 看板娘形象 key（管理员在管理面板切换）；probed = 探测请求已返回 */
	const [modelKey, setModelKey] = useState("shizuku");
	const [probed, setProbed] = useState(false);
	/** 剩余聊天次数（-1=无限：管理员或已接入自己的模型；null=未知） */
	const [remaining, setRemaining] = useState<number | null>(null);
	/** 我在用哪种模型：own=自己的（无限）/ site=站内 / null=未登录 */
	const [myMode, setMyMode] = useState<"own" | "site" | null>(null);
	const [myModel, setMyModel] = useState<string | null>(null);

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
			if (typeof d.remaining === "number") setRemaining(d.remaining);
			if (d.myMode !== undefined) setMyMode(d.myMode);
			if (d.myModel !== undefined) setMyModel(d.myModel ?? null);
		} catch {
			/* 探测失败按未配置走 */
		} finally {
			setProbed(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		void probe();
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

	const sendChat = (text: string): void => {
		const content = text.trim();
		if (!content || waiting) return;
		setChatError(null);
		const nextMessages: PetChatMessage[] = [
			...messages,
			{ role: "user", content },
		];
		setMessages(nextMessages);
		setWaiting(true);
		fetch("/api/pet", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: nextMessages.slice(-10) }),
		})
			.then(async (r) => {
				const data = (await r.json().catch(() => ({}))) as {
					reply?: string;
					error?: string;
					remaining?: number;
				};
				if (typeof data.remaining === "number") setRemaining(data.remaining);
				if (!r.ok || !data.reply) throw new Error(data.error || "回复失败");
				setMessages((prev) => [
					...prev,
					{ role: "assistant", content: data.reply! },
				]);
			})
			.catch((err) => {
				setChatError(err instanceof Error ? err.message : "回复失败");
			})
			.finally(() => setWaiting(false));
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
		/** 保存/断开自己的模型后调用，刷新剩余次数与模式 */
		refresh: () => void probe(),
		clearChat: () => {
			setMessages([]);
			setChatError(null);
		},
	};
}
