/**
 * 站点吉祥物（右下角浮动小猫）
 * - 纯内联 SVG 的圆滚滚粉色小猫：耳朵、眯眯眼（周期性眨眼）、腮红、摇摆尾巴
 * - 所有动画走 <style> 内 keyframes，类名前缀 sitepet-，尊重 prefers-reduced-motion
 * - 点击（未接 AI）：跳跃一下 + 头顶气泡说一句随机文案（busy 时偏好“上传中”主题）
 * - 点击（已接 AI，管理面板配置）：打开对话面板，走 /api/pet 服务端代理（key 不出服务端），
 *   聊天记录存 localStorage wlist-pet-chat
 */
import { useEffect, useRef, useState } from "react";
import { usePetChat } from "./usePetChat";

/** 日常台词（含网盘 / 上传主题） */
const PHRASES: string[] = [
	"传完啦，摸摸我~",
	"今天也要好好备份哦！",
	"20G 也不在话下喵！",
	"我是守盘小猫 ฅ^•ﻌ•^ฅ",
	"喵呜~ 文件都在这里躺好啦",
	"摸摸头，网速会变快的喵",
	"分享链接记得设密码哦~",
	"上传累了？一起打个盹 zzz",
	"直链下载，比我追毛线球还快！",
	"磁盘满满的，都是你的回忆呀",
	"喵？有什么想存的尽管交给我",
	"我一直守在右下角，别忘了我喵",
];

/** 上传进行中的台词 */
const BUSY_PHRASES: string[] = [
	"正在努力上传中，等我一下喵…",
	"传输中…别关页面哦！",
	"上传ing，我帮你盯着进度呢",
	"数据包搬运中，喵喵加油！",
	"马上就好，再撸我一下下~",
];

const STYLE = `
@keyframes sitepet-bob {
	0%, 100% { transform: translateY(0); }
	50% { transform: translateY(-6px); }
}
@keyframes sitepet-blink {
	0%, 90%, 100% { transform: scaleY(1); }
	94% { transform: scaleY(0.08); }
	98% { transform: scaleY(1); }
}
@keyframes sitepet-wag {
	0%, 100% { transform: rotate(6deg); }
	50% { transform: rotate(-16deg); }
}
@keyframes sitepet-twitch {
	0%, 60%, 68%, 100% { transform: rotate(0deg); }
	63% { transform: rotate(12deg); }
	65.5% { transform: rotate(-5deg); }
}
@keyframes sitepet-hop {
	0% { transform: translateY(0) scale(1); }
	35% { transform: translateY(-20px) scale(1.06); }
	60% { transform: translateY(0) scale(1); }
	75% { transform: translateY(-6px) scale(1.02); }
	100% { transform: translateY(0) scale(1); }
}
@keyframes sitepet-bubble-in {
	0% { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.7); }
	60% { opacity: 1; transform: translateX(-50%) translateY(-2px) scale(1.05); }
	100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
@keyframes sitepet-panel-in {
	0% { opacity: 0; transform: translateY(10px) scale(0.96); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
.sitepet-bob { animation: sitepet-bob 3s ease-in-out infinite; }
.sitepet-blink {
	transform-box: view-box;
	transform-origin: 60px 62px;
	animation: sitepet-blink 4s ease-in-out infinite;
}
.sitepet-wag {
	transform-box: view-box;
	transform-origin: 27px 83px;
	animation: sitepet-wag 1s ease-in-out infinite;
}
.sitepet-twitch {
	transform-box: view-box;
	transform-origin: 90px 46px;
	animation: sitepet-twitch 7s ease-in-out infinite;
}
.sitepet-hop { animation: sitepet-hop 0.55s cubic-bezier(0.3, 0.8, 0.4, 1.2) 1; }
.sitepet-bubble-in { animation: sitepet-bubble-in 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) 1 both; }
.sitepet-panel-in { animation: sitepet-panel-in 0.22s cubic-bezier(0.34, 1.4, 0.64, 1) 1 both; }
@media (prefers-reduced-motion: reduce) {
	.sitepet-bob,
	.sitepet-blink,
	.sitepet-wag,
	.sitepet-twitch,
	.sitepet-hop,
	.sitepet-bubble-in,
	.sitepet-panel-in {
		animation: none !important;
	}
}
`;

export default function SitePet({ busy }: { busy?: boolean }) {
	const [phrase, setPhrase] = useState<string | null>(null);
	const [hopKey, setHopKey] = useState(0);
	const timerRef = useRef<number | undefined>(undefined);
	const lastIdxRef = useRef(-1);

	// AI 聊天状态
	const [chatOpen, setChatOpen] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const { aiConfigured, messages, waiting, chatError, sendChat, clearChat } =
		usePetChat();

	// 卸载时清掉气泡定时器
	useEffect(() => {
		return () => window.clearTimeout(timerRef.current);
	}, []);

	// 新消息滚动到底
	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [messages, waiting]);

	const poke = (): void => {
		const pool = busy ? BUSY_PHRASES : PHRASES;
		let idx = Math.floor(Math.random() * pool.length);
		if (pool.length > 1 && idx === lastIdxRef.current) {
			idx = (idx + 1) % pool.length;
		}
		lastIdxRef.current = idx;
		setPhrase(pool[idx]);
		setHopKey((k) => k + 1);
		window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => setPhrase(null), 3500);
	};

	const toggleChat = (): void => {
		setChatOpen((open) => {
			const next = !open;
			if (next) {
				setHopKey((k) => k + 1);
				window.setTimeout(() => inputRef.current?.focus(), 120);
			}
			return next;
		});
	};

	return (
		<div className="fixed right-4 bottom-[88px] z-40 select-none">
			<style>{STYLE}</style>

			{/* 对话面板（接上 AI 后点小猫打开） */}
			{chatOpen && (
				<div className="sitepet-panel-in absolute bottom-full right-0 mb-3 flex w-[17.5rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:w-72">
					{/* 头部 */}
					<div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/60">
						<div className="flex items-center gap-1.5">
							<span className="text-sm" aria-hidden>
								🐱
							</span>
							<span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
								守盘小猫
							</span>
							{aiConfigured && (
								<span className="rounded bg-emerald-100 px-1 text-[9px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
									AI
								</span>
							)}
						</div>
						<div className="flex items-center gap-0.5">
							{/* 面板里保留戳一戳的乐趣 */}
							<button
								type="button"
								title="摸摸头"
								className="rounded p-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
								onClick={poke}
							>
								🐾
							</button>
							<button
								type="button"
								title="清空聊天"
								className="rounded p-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
								onClick={clearChat}
							>
								🧹
							</button>
							{messages.length > 0 && (
								<button
									type="button"
									title="收起"
									className="rounded px-1.5 py-1 text-xs leading-none text-zinc-500 hover:bg-black/5 dark:hover:bg-white/10"
									onClick={() => setChatOpen(false)}
								>
									✕
								</button>
							)}
						</div>
					</div>

					{/* 消息列表 */}
					<div ref={listRef} className="flex max-h-64 min-h-[5.5rem] flex-col gap-1.5 overflow-y-auto p-2.5">
						{messages.length === 0 && !waiting && (
							<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
								跟小猫打个招呼吧~
								<br />
								她知道这个站的各种玩法喵
							</p>
						)}
						{messages.map((m, i) => (
							<div
								key={i}
								className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
							>
								<div
									className={`max-w-[85%] rounded-2xl px-2.5 py-1.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap ${
										m.role === "user"
											? "rounded-br-sm bg-accent-500 text-white"
											: "rounded-bl-sm bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
									}`}
								>
									{m.content}
								</div>
							</div>
						))}
						{waiting && (
							<div className="flex justify-start">
								<div className="rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2 text-[12.5px] text-zinc-400 dark:bg-zinc-800">
									<span className="animate-pulse">喵…在想</span>
								</div>
							</div>
						)}
						{chatError && (
							<p className="rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
								{chatError}
							</p>
						)}
					</div>

					{/* 输入区 */}
					<form
						className="flex items-center gap-1.5 border-t border-zinc-100 p-2 dark:border-zinc-800"
						onSubmit={(e) => {
							e.preventDefault();
							sendChat(chatInput);
							setChatInput("");
						}}
					>
						<input
							ref={inputRef}
							className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[12.5px] text-zinc-800 outline-none focus:border-pink-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-pink-600"
							placeholder="说点什么…"
							maxLength={500}
							value={chatInput}
							onChange={(e) => setChatInput(e.target.value)}
						/>
						<button
							type="submit"
							className="shrink-0 rounded-full bg-pink-400 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-pink-500 disabled:opacity-50"
							disabled={waiting || !chatInput.trim()}
						>
							喵
						</button>
					</form>
				</div>
			)}

			{/* 头顶气泡 */}
			{phrase !== null && (
				<div
					key={hopKey}
					className={`sitepet-bubble-in absolute bottom-full mb-2 w-max max-w-[13rem] ${
						chatOpen ? "right-14" : "left-1/2"
					}`}
					role="status"
				>
					<div className="relative rounded-2xl border border-zinc-200 bg-white px-3.5 py-2 text-center text-sm text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
						{phrase}
						{/* 气泡小尾巴 */}
						<span className="absolute left-1/2 top-full h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800" />
					</div>
				</div>
			)}

			<button
				type="button"
				title={aiConfigured ? "和我聊天（摸摸头看运气）" : "戳我一下"}
				aria-label={aiConfigured ? "和小猫聊天" : "戳我一下"}
				onClick={aiConfigured ? toggleChat : poke}
				className="relative block cursor-pointer rounded-full opacity-90 transition-all duration-200 hover:scale-105 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-95"
			>
				{/* 跳跃动画在外层 div、待机浮动在 svg，两个 animation 互不覆盖 */}
				<div key={hopKey} className="sitepet-hop">
					<svg
						viewBox="0 0 120 120"
						width="72"
						height="72"
						className="sitepet-bob block drop-shadow-[0_6px_10px_rgba(0,0,0,0.18)]"
						aria-hidden="true"
					>
						{/* 尾巴 */}
						<path
							className="sitepet-wag"
							d="M27 83 Q5 79 9 56"
							fill="none"
							stroke="#f2b48c"
							strokeWidth="8"
							strokeLinecap="round"
						/>

						{/* 左耳 */}
						<path d="M33 46 L27 16 L56 33 Z" fill="#ffe4cd" stroke="#f2b48c" strokeWidth="3" strokeLinejoin="round" />
						<path d="M34.5 40 L31.5 24 L46 32.5 Z" fill="#ffc4c4" strokeLinejoin="round" />

						{/* 右耳（偶尔抖一下） */}
						<g className="sitepet-twitch">
							<path d="M87 46 L93 16 L64 33 Z" fill="#ffe4cd" stroke="#f2b48c" strokeWidth="3" strokeLinejoin="round" />
							<path d="M85.5 40 L88.5 24 L74 32.5 Z" fill="#ffc4c4" strokeLinejoin="round" />
						</g>

						{/* 圆滚滚的身体 */}
						<ellipse cx="60" cy="70" rx="38" ry="34" fill="#ffe4cd" stroke="#f2b48c" strokeWidth="3" />

						{/* 眯眯眼（会眨） */}
						<g className="sitepet-blink" fill="none" stroke="#8a5a44" strokeWidth="3.5" strokeLinecap="round">
							<path d="M38 64 Q45 56 52 64" />
							<path d="M68 64 Q75 56 82 64" />
						</g>

						{/* 腮红 */}
						<ellipse cx="33" cy="72" rx="6" ry="3.5" fill="#ffb4b4" opacity="0.85" />
						<ellipse cx="87" cy="72" rx="6" ry="3.5" fill="#ffb4b4" opacity="0.85" />

						{/* ω 小猫嘴 */}
						<path d="M53 71 q3.5 5 7 0 q3.5 5 7 0" fill="none" stroke="#8a5a44" strokeWidth="2.5" strokeLinecap="round" />
					</svg>
				</div>

				{/* 已接 AI：头上挂个小对话气泡角标，提示可聊天 */}
				{aiConfigured && (
					<span className="absolute -right-0.5 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-pink-400 text-[10px] shadow-md">
						💬
					</span>
				)}
			</button>
		</div>
	);
}
