/**
 * 守盘小窝：右下角的迷你房间 + Live2D 看板娘
 * - 场景（纯 CSS/SVG）：暖色墙壁、木地板、窗户（夜里月亮星星/白天太阳）、台灯、盆栽、相框、地毯
 *   —— 日/夜跟随站点主题（wlist-theme）
 * - 形象：Live2D Haru（官方迎宾少女，瞳孔跟鼠标、眨眼、待机动作、点击互动）
 *   模型文件托管在本站 /live2d/haru/（3MB 首次点击展开才加载，懒加载）
 * - WebGL / 模型加载失败 → 回退到 SVG 守盘小猫（SitePet）
 * - AI（管理员在管理面板配置后）：点头像/输入框和她聊天，走 /api/pet 代理
 */
import { useCallback, useEffect, useRef, useState } from "react";
import SitePet from "./SitePet";
import { usePetChat } from "./usePetChat";

/** 日常台词（看板娘版） */
const PHRASES: string[] = [
	"欢迎回来~ 要找什么文件呀？",
	"我一直在小窝里守着大家的文件哦",
	"传输盘的文件 7 天会过期，记得及时取走~",
	"上传大文件的时候，可以随时来找我聊天",
	"摸摸头…啊，是隔着屏幕呀",
	"今天也把重要的东西备份好了吗？",
	"分享链接记得设密码哦，我可是会担心的",
	"小窝虽然小，但是很温馨对吧？",
];

const BUSY_PHRASES: string[] = [
	"正在帮你盯上传进度呢…",
	"数据搬运中，别关页面哦！",
	"传输中…我设置成随时待命了",
];

const COLLAPSE_KEY = "wlist-pet-home-collapsed";

const STYLE = `
@keyframes petroom-twinkle {
	0%, 100% { opacity: 0.25; }
	50% { opacity: 1; }
}
@keyframes petroom-lamp-glow {
	0%, 100% { opacity: 0.55; }
	50% { opacity: 0.9; }
}
@keyframes petroom-shooting {
	0% { transform: translate(0, 0) rotate(-35deg); opacity: 0; }
	6% { opacity: 1; }
	40% { transform: translate(-46px, 32px) rotate(-35deg); opacity: 0; }
	100% { transform: translate(-46px, 32px) rotate(-35deg); opacity: 0; }
}
@keyframes petroom-bubble-in {
	0% { opacity: 0; transform: translateY(6px) scale(0.85); }
	60% { opacity: 1; transform: translateY(-2px) scale(1.04); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes petroom-panel-in {
	0% { opacity: 0; transform: translateY(8px) scale(0.97); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
.petroom-star { animation: petroom-twinkle 2.6s ease-in-out infinite; }
.petroom-lamp-glow { animation: petroom-lamp-glow 3.2s ease-in-out infinite; }
.petroom-shooting { animation: petroom-shooting 5s linear infinite; }
.petroom-bubble-in { animation: petroom-bubble-in 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) 1 both; }
.petroom-panel-in { animation: petroom-panel-in 0.22s cubic-bezier(0.34, 1.4, 0.64, 1) 1 both; }
@media (prefers-reduced-motion: reduce) {
	.petroom-star,
	.petroom-lamp-glow,
	.petroom-shooting,
	.petroom-bubble-in,
	.petroom-panel-in {
		animation: none !important;
	}
}
`;

/** 小屋尺寸（px）——Live2D 画布按此适配 */
const ROOM_W = 300;
const ROOM_H = 340;
const FLOOR_TOP = 268; // 地板上沿 y（人物脚底站这）

export default function Live2DHome({ busy }: { busy?: boolean }) {
	// 'loading' = 决定用 Live2D 还是回退；'live2d' | 'svg'
	const [mode, setMode] = useState<"loading" | "live2d" | "svg">("loading");
	const [collapsed, setCollapsed] = useState<boolean | null>(null); // null = SSR 未读
	const [phrase, setPhrase] = useState<string | null>(null);
	const phraseTimer = useRef<number | undefined>(undefined);

	const stageRef = useRef<HTMLDivElement | null>(null);
	const appRef = useRef<{ destroy: () => void } | null>(null);
	const modelRef = useRef<{
		focus: (x: number, y: number) => void;
		motion: (group: string) => unknown;
		expression: (name: string) => unknown;
	} | null>(null);

	const [chatOpen, setChatOpen] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const { aiConfigured, messages, waiting, chatError, sendChat, clearChat } =
		usePetChat();

	// 折叠状态：默认折叠（模型 ~3MB，想看再展开加载）；记住用户的选择
	useEffect(() => {
		setCollapsed(localStorage.getItem(COLLAPSE_KEY) !== "0");
	}, []);
	const toggleCollapse = () => {
		setCollapsed((prev) => {
			const next = !(prev ?? true);
			localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
			return next;
		});
	};

	const poke = useCallback(() => {
		const pool = busy ? BUSY_PHRASES : PHRASES;
		setPhrase(pool[Math.floor(Math.random() * pool.length)]);
		window.clearTimeout(phraseTimer.current);
		phraseTimer.current = window.setTimeout(() => setPhrase(null), 3500);
	}, [busy]);

	// 卸载清理
	useEffect(() => {
		return () => {
			window.clearTimeout(phraseTimer.current);
			appRef.current?.destroy();
		};
	}, []);

	// 展开 Live2D 小窝时初始化（懒加载：模型 3MB，只在第一次展开时拉）
	useEffect(() => {
		if (collapsed !== false || mode !== "loading") return;
		let disposed = false;
		(async () => {
			try {
				// 1) Cubism Core（官方运行时，本地托管）
				if (!window.Live2DCubismCore) {
					await new Promise<void>((resolve, reject) => {
						const s = document.createElement("script");
						s.src = "/live2d/core/live2dcubismcore.min.js";
						s.onload = () => resolve();
						s.onerror = () => reject(new Error("core load failed"));
						document.head.appendChild(s);
					});
				}
				// 2) pixi + live2d 显示层（动态 import：SSR 无关、不进主 bundle）
				const pixi = await import("pixi.js");
				const { Live2DModel } = await import("pixi-live2d-display/cubism4");
				// pixi-live2d-display 需要 window.PIXI 暴露（Ticker 等自动注册）
				(window as unknown as { PIXI: unknown }).PIXI = pixi;
				if (disposed || !stageRef.current) return;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const PIXI = pixi as any;

				const app = new PIXI.Application({
					width: ROOM_W,
					height: ROOM_H,
					backgroundAlpha: 0,
					antialias: true,
				});
				const canvas = app.view as HTMLCanvasElement;
				canvas.style.width = "100%";
				canvas.style.height = "100%";
				canvas.style.display = "block";
				stageRef.current.appendChild(canvas);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const model = (await Live2DModel.from(
					"/live2d/haru/haru_greeter_t03.model3.json"
				)) as any;
				if (disposed) {
					model.destroy?.();
					app.destroy(true);
					return;
				}
				model.anchor.set(0.5, 1); // 底部中心 = 脚站地板
				model.position.set(ROOM_W * 0.52, FLOOR_TOP + 6);
				model.scale.set(0.205); // haru 逻辑高约 1380 → 约 283px
				// 点击身体/头：互动动作 + 随机表情 + 台词
				model.on("hit", () => {
					model.motion("Tap");
					model.expression(`f0${Math.floor(Math.random() * 8)}`);
					poke();
				});
				app.stage.addChild(model);
				appRef.current = app;
				modelRef.current = model;
				setMode("live2d");
			} catch (err) {
				console.warn("Live2D 小窝加载失败，回退 SVG 小猫:", err);
				setMode("svg");
			}
		})();
		return () => {
			disposed = true;
		};
	}, [collapsed, mode, poke]);

	// 鼠标悬停小窝 → 视线跟随
	const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const model = modelRef.current;
		if (!model) return;
		const rect = e.currentTarget.getBoundingClientRect();
		model.focus(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-(((e.clientY - rect.top) / rect.height) * 2 - 1)
		);
	};

	// 新消息滚动到底
	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [messages, waiting]);

	if (collapsed === null) return null; // SSR/首帧不定，避免闪烁

	// 回退：原守盘小猫（WebGL 不可用 / 模型加载失败）
	if (collapsed === false && mode === "svg") {
		return <SitePet busy={busy} />;
	}

	// 折叠态：屋檐小按钮
	if (collapsed) {
		return (
			<div className="fixed right-4 bottom-4 z-40">
				<style>{STYLE}</style>
				<button
					type="button"
					title="打开守盘小窝"
					aria-label="打开守盘小窝"
					onClick={toggleCollapse}
					className="group relative flex h-14 w-14 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-amber-200/80 bg-gradient-to-b from-amber-50 to-orange-100 shadow-lg transition-transform hover:scale-105 active:scale-95 dark:border-amber-700/50 dark:from-zinc-800 dark:to-zinc-900"
				>
					<span className="text-2xl leading-none" aria-hidden>
						🏠
					</span>
					{aiConfigured && (
						<span className="absolute -right-1 -top-1 rounded-full bg-pink-400 px-1 text-[9px] font-bold text-white shadow">
							AI
						</span>
					)}
				</button>
			</div>
		);
	}

	// ========== 展开态：小房间 + 看板娘 ==========
	return (
		<div className="fixed right-4 bottom-4 z-40 select-none">
			<style>{STYLE}</style>

			{/* 聊天面板（AI 已配置，从角色左侧弹出） */}
			{chatOpen && aiConfigured && (
				<div className="petroom-panel-in absolute bottom-2 right-[calc(100%+0.75rem)] flex h-72 w-[16rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
					<div className="flex items-center justify-between border-b border-zinc-100 bg-gradient-to-r from-amber-50 to-orange-50 px-3 py-2 dark:border-zinc-800 dark:from-amber-950/30 dark:to-orange-950/20">
						<div className="flex items-center gap-1.5">
							<span className="text-xs" aria-hidden>
								🌸
							</span>
							<span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
								和小窝看板娘聊天
							</span>
						</div>
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								title="清空聊天"
								className="rounded p-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
								onClick={clearChat}
							>
								🧹
							</button>
							<button
								type="button"
								title="收起"
								className="rounded px-1.5 py-1 text-xs leading-none text-zinc-500 hover:bg-black/5 dark:hover:bg-white/10"
								onClick={() => setChatOpen(false)}
							>
								✕
							</button>
						</div>
					</div>
					<div
						ref={listRef}
						className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5"
					>
						{messages.length === 0 && !waiting && (
							<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
								跟她打个招呼吧~
								<br />
								她知道这个站的各种玩法
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
											? "rounded-br-sm bg-blue-500 text-white"
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
									<span className="animate-pulse">想想看…</span>
								</div>
							</div>
						)}
						{chatError && (
							<p className="rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
								{chatError}
							</p>
						)}
					</div>
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
							className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[12.5px] text-zinc-800 outline-none focus:border-amber-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-amber-600"
							placeholder="说点什么…"
							maxLength={500}
							value={chatInput}
							onChange={(e) => setChatInput(e.target.value)}
						/>
						<button
							type="submit"
							className="shrink-0 rounded-full bg-amber-400 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
							disabled={waiting || !chatInput.trim()}
						>
							发送
						</button>
					</form>
				</div>
			)}

			{/* 台词气泡（角色头顶，聊天面板与气泡共存时错开） */}
			{phrase && (
				<div
					className="petroom-bubble-in absolute bottom-[calc(100%-1.25rem)] left-3 z-20 w-max max-w-[12rem]"
					role="status"
				>
					<div className="relative rounded-2xl border border-zinc-200 bg-white px-3.5 py-2 text-center text-[13px] text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
						{phrase}
						<span className="absolute bottom-0 left-5 h-2.5 w-2.5 translate-y-1/2 rotate-45 border-b border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800" />
					</div>
				</div>
			)}

			{/* ======== 小房间 ======== */}
			<div
				className="relative overflow-hidden rounded-[28px] border-2 shadow-2xl transition-shadow hover:shadow-amber-200/40 dark:hover:shadow-amber-900/20"
				style={{ width: ROOM_W, height: ROOM_H }}
			>
				{/* 墙壁 */}
				<div className="absolute inset-0 bg-gradient-to-b from-orange-50 via-amber-50 to-amber-100 dark:from-indigo-950 dark:via-slate-950 dark:to-indigo-950" />

				{/* 窗户（夜=月亮星星 / 昼=太阳） */}
				<svg
					className="absolute left-5 top-9"
					width="76"
					height="88"
					viewBox="0 0 76 88"
					aria-hidden="true"
				>
					<rect x="1.5" y="1.5" width="73" height="85" rx="10" fill="#bfdbfe" className="dark:hidden" />
					<rect x="1.5" y="1.5" width="73" height="85" rx="10" fill="#1e293b" className="hidden dark:inline" />
					{/* 白天：太阳和云 */}
					<g className="dark:hidden">
						<circle cx="52" cy="20" r="10" fill="#fbbf24" />
						<ellipse cx="26" cy="38" rx="12" ry="6" fill="#fff" opacity="0.9" />
						<ellipse cx="34" cy="35" rx="9" ry="5" fill="#fff" opacity="0.9" />
					</g>
					{/* 夜晚：月亮和星星 */}
					<g className="hidden dark:inline">
						<circle cx="50" cy="22" r="11" fill="#fde68a" />
						<circle cx="46" cy="19" r="9" fill="#1e293b" />
						<circle className="petroom-star" cx="18" cy="20" r="1.8" fill="#fef9c3" />
						<circle className="petroom-star" style={{ animationDelay: "0.9s" }} cx="30" cy="34" r="1.4" fill="#fef9c3" />
						<circle className="petroom-star" style={{ animationDelay: "1.7s" }} cx="16" cy="46" r="1.6" fill="#fef9c3" />
					</g>
					{/* 上传时窗外流星 */}
					{busy && (
						<g className="hidden dark:inline">
							<line className="petroom-shooting" x1="64" y1="8" x2="72" y2="8" stroke="#fef08a" strokeWidth="2" strokeLinecap="round" />
						</g>
					)}
					{/* 窗框十字 */}
					<rect x="1.5" y="1.5" width="73" height="85" rx="10" fill="none" stroke="#d97706" strokeWidth="3" />
					<line x1="38" y1="2" x2="38" y2="86" stroke="#d97706" strokeWidth="2.5" />
					<line x1="2" y1="44" x2="74" y2="44" stroke="#d97706" strokeWidth="2.5" />
				</svg>

				{/* 墙上相框（里面是原来的小猫剪影——她还在哦） */}
				<svg
					className="absolute right-[7.5rem] top-10"
					width="42"
					height="34"
					viewBox="0 0 42 34"
					aria-hidden="true"
				>
					<rect x="1" y="1" width="40" height="32" rx="3" fill="#fffbeb" stroke="#b45309" strokeWidth="2" />
					<circle cx="21" cy="19" r="8" fill="#f9a8d4" />
					<path d="M14 13 L12 4 L21 9 Z M28 13 L30 4 L21 9 Z" fill="#f9a8d4" />
					<path d="M17 19 q2 2.5 4 0 q2 2.5 4 0" fill="none" stroke="#9d174d" strokeWidth="1.4" strokeLinecap="round" />
				</svg>

				{/* 台灯（夜里亮） */}
				<div className="absolute right-4 bottom-[4.5rem] flex flex-col items-center" aria-hidden="true">
					<div className="absolute -top-2 left-1/2 h-14 w-14 -translate-x-1/2 rounded-full bg-amber-200/60 blur-xl petroom-lamp-glow dark:bg-amber-300/25" />
					<div className="relative h-6 w-10 rounded-t-[999px] bg-gradient-to-b from-amber-400 to-amber-500 dark:from-amber-300 dark:to-amber-600" />
					<div className="h-9 w-1.5 bg-amber-700/80" />
					<div className="h-1.5 w-8 rounded-full bg-amber-800/80" />
				</div>

				{/* 盆栽 */}
				<svg className="absolute left-3 bottom-[4.2rem]" width="34" height="44" viewBox="0 0 34 44" aria-hidden="true">
					<path d="M12 22 Q9 14 14 8 M17 22 Q17 12 17 6 M22 22 Q25 14 20 8" fill="none" stroke="#15803d" strokeWidth="2.5" strokeLinecap="round" />
					<path d="M8 24 h18 l-2 12 h-14 Z" fill="#c2410c" stroke="#9a3412" strokeWidth="1.5" strokeLinejoin="round" />
				</svg>

				{/* 地毯 */}
				<div
					className="absolute left-1/2 rounded-[50%] border-2 border-rose-200/70 bg-rose-100/80 dark:border-rose-900/60 dark:bg-rose-950/40"
					style={{ top: FLOOR_TOP - 24, width: 190, height: 56, transform: "translateX(-50%)" }}
					aria-hidden="true"
				/>

				{/* 木地板（白天/夜晚两套） */}
				<div
					className="absolute inset-x-0 bottom-0 border-t-4 border-amber-700/60 dark:hidden"
					style={{
						height: ROOM_H - FLOOR_TOP,
						background:
							"repeating-linear-gradient(90deg, #e7c9a9 0 34px, #dcb894 34px 68px)",
					}}
					aria-hidden="true"
				/>
				<div
					className="absolute inset-x-0 bottom-0 hidden border-t-4 border-amber-900/70 dark:block"
					style={{
						height: ROOM_H - FLOOR_TOP,
						background:
							"repeating-linear-gradient(90deg, #6b5340 0 34px, #5c4838 34px 68px)",
					}}
					aria-hidden="true"
				/>

				{/* Live2D 画布（人物叠在场景上，点击=互动，悬停=视线跟随） */}
				<div
					ref={stageRef}
					className="absolute inset-0 z-10 cursor-pointer"
					onPointerMove={onStagePointerMove}
					title="她是小窝的看板娘，点点看？"
				/>

				{/* 加载中 / 失败提示 */}
				{mode === "loading" && (
					<div className="absolute inset-0 z-20 flex items-center justify-center">
						<span className="animate-pulse rounded-full bg-white/80 px-3 py-1 text-xs text-amber-600 shadow dark:bg-zinc-800/80 dark:text-amber-300">
							看板娘睡醒了穿衣服中…
						</span>
					</div>
				)}

				{/* 顶栏（最后画，在最上层）：名字 / 聊天入口 / 收起 */}
				<div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-3 py-1.5">
					<span className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-semibold text-amber-700 backdrop-blur-sm dark:bg-zinc-800/60 dark:text-amber-300">
						🛏️ 守盘小窝
					</span>
					<div className="flex items-center gap-1">
						{aiConfigured && (
							<button
								type="button"
								title="和她聊天"
								onClick={() => {
									setChatOpen((o) => !o);
									window.setTimeout(() => inputRef.current?.focus(), 120);
								}}
								className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-medium text-pink-600 backdrop-blur-sm transition-colors hover:bg-pink-100 dark:bg-zinc-800/60 dark:text-pink-300 dark:hover:bg-pink-950/50"
							>
								💬 聊天
							</button>
						)}
						<button
							type="button"
							title="收起小窝"
							onClick={toggleCollapse}
							className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] text-zinc-500 backdrop-blur-sm transition-colors hover:bg-zinc-100 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:bg-zinc-700"
						>
							▾
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
