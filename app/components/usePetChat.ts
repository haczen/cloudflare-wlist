/**
 * 守盘看板娘 / 小猫共用的 AI 聊天 hook
 * - 挂载后探测 /api/pet 是否已配置（管理员接入了 LLM）
 * - 聊天记录存 localStorage wlist-pet-chat（最近 30 条，随设备不迁移）
 * - 发送：上下文只带最近 10 条（服务端有同样的钳制）
 */
import { useEffect, useState } from "react";

export interface PetChatMessage {
	role: "user" | "assistant";
	content: string;
}

const CHAT_STORAGE_KEY = "wlist-pet-chat";
const CHAT_KEEP = 30;

export function usePetChat() {
	const [aiConfigured, setAiConfigured] = useState(false);
	const [messages, setMessages] = useState<PetChatMessage[]>([]);
	const [waiting, setWaiting] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	/** 看板娘形象 key（管理员在管理面板切换）；probed = 探测请求已返回 */
	const [modelKey, setModelKey] = useState("shizuku");
	const [probed, setProbed] = useState(false);

	// 探测 + 恢复记录（都在 effect 里，SSR 安全）
	useEffect(() => {
		fetch("/api/pet")
			.then((r) => (r.ok ? r.json() : null))
			.then((d: { configured?: boolean; petModel?: string } | null) => {
				if (d?.configured) setAiConfigured(true);
				if (d?.petModel) setModelKey(d.petModel);
			})
			.catch(() => {
				/* 探测失败按未配置走，不影响戳一戳 */
			})
			.finally(() => setProbed(true));
		try {
			const saved = localStorage.getItem(CHAT_STORAGE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as PetChatMessage[];
				if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
			}
		} catch {
			/* 损坏忽略 */
		}
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
				};
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
		clearChat: () => {
			setMessages([]);
			setChatError(null);
		},
	};
}
