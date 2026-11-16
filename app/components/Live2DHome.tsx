/**
 * 守盘小窝：看板娘（Live2D Shizuku）+ 可展开的小房间
 * - 默认形态：人物直接漂在页面右下角（透明底、约 120px Q 版身形），
 *   不需要点开小屋就能看到她——点头像互动、鼠标划过她眼睛跟着看
 * - 🏠 小按钮展开迷你房间（纯 CSS/SVG：暖墙/木地板/窗日月切换/台灯/盆栽/相框/地毯），
 *   日夜跟随站点主题；再点收起回到悬浮形态
 * - 灵动性：待机动作自动播；每 18~40 秒随机挑一个舞蹈/小动作自己玩，
 *   换随机表情、偶尔冒一句台词
 * - AI（管理面板配置后）：💬 和她聊天，走 /api/pet 服务端代理（key 不出服务端）
 * - 模型加载失败 / WebGL 不可用 → 回退 SVG 守盘小猫（SitePet）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import SitePet from "./SitePet";
import { usePetChat } from "./usePetChat";

/** 日常台词 */
const PHRASES: string[] = [
	"欢迎回来~ 要找什么文件呀？",
	"我一直在右下角守着大家的文件哦",
	"传输盘的文件 7 天会过期，记得及时取走~",
	"上传大文件的时候，可以随时来找我聊天",
	"摸摸头…啊，是隔着屏幕呀",
	"今天也把重要的东西备份好了吗？",
	"分享链接记得设密码哦，我可是会担心的",
	"嘿嘿，刚才那个动作可爱吗？",
];

const BUSY_PHRASES: string[] = [
	"正在帮你盯上传进度呢…",
	"数据搬运中，别关页面哦！",
	"传输中…我随时待命",
];

const ROOM_KEY = "wlist-pet-room-open";

/** 自发玩耍的动作库（model.json 的动组名）+ 表情 */
const PLAY_MOTION_GROUPS = [
	"tap_body",
	"shake",
	"flick_head",
	"pinch_in",
	"pinch_out",
];
const EXPRESSIONS = ["f01", "f02", "f03", "f04"];

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

/** 画布逻辑尺寸（房间坐标系的绝对基准，悬浮态只是整体 CSS 缩小） */
const ROOM_W = 300;
const ROOM_H = 340;
const FLOOR_TOP = 268;
/** 房内目标身高（约房高 65%；悬浮态 0.55 缩放 → 视觉约 120px） */
const TARGET_H = 220;
/** 悬浮形态整个画布的 CSS 缩放 */
const FLOAT_SCALE = 0.55;

export default function Live2DHome({ busy }: { busy?: boolean }) {
	// 'loading' = 决定用 Live2D 还是回退；'live2d' | 'svg'
	const [mode, setMode] = useState<"loading" | "live2d" | "svg">("loading");
	// 房间是否展开；null = SSR 未读（不渲染，防闪烁）。默认 false：人物直接悬浮展示
	const [roomOpen, setRoomOpen] = useState<boolean | null>(null);
	const [phrase, setPhrase] = useState<string | null>(null);
	const phraseTimer = useRef<number | undefined>(undefined);

	const stageRef = useRef<HTMLDivElement | null>(null);
	const appRef = useRef<{ destroy: () => void } | null>(null);
	const modelRef = useRef<{
		focus: (x: number, y: number) => void;
		motion: (group: string) => unknown;
		expression: (name: string) => unknown;
		height: number;
		width: number;
		x: number;
		y: number;
	} | null>(null);

	const [chatOpen, setChatOpen] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const { aiConfigured, messages, waiting, chatError, sendChat, clearChat } =
		usePetChat();

	// 房间开关：记住用户选择
	useEffect(() => {
		setRoomOpen(localStorage.getItem(ROOM_KEY) === "1");
	}, []);
	const toggleRoom = () => {
		setRoomOpen((prev) => {
			const next = !(prev ?? false);
			localStorage.setItem(ROOM_KEY, next ? "1" : "0");
			return next;
		});
	};

	const poke = useCallback(() => {
		const pool = busy ? BUSY_PHRASES : PHRASES;
		setPhrase(pool[Math.floor(Math.random() * pool.length)]);
		window.clearTimeout(phraseTimer.current);
		phraseTimer.current = window.setTimeout(() => setPhrase(null), 3500);
	}, [busy]);

	const playRandom = useCallback(() => {
		const m = modelRef.current;
		if (!m) return;
		m.motion(PLAY_MOTION_GROUPS[Math.floor(Math.random() * PLAY_MOTION_GROUPS.length)]);
		m.expression(EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)]);
	}, []);

	// 卸载清理
	useEffect(() => {
		return () => {
			window.clearTimeout(phraseTimer.current);
			appRef.current?.destroy();
		};
	}, []);

	// 客户端状态就绪后加载模型（悬浮态也要显示人物，所以开不开房都加载）
	useEffect(() => {
		if (roomOpen === null || mode !== "loading") return;
		let disposed = false;
		(async () => {
			try {
				// 1) Cubism 2 官方 runtime（live2d.min.js 提供全局 Live2D，渲染库依赖）
				if (!(window as unknown as { Live2D?: unknown }).Live2D) {
					await new Promise<void>((resolve, reject) => {
						const s = document.createElement("script");
						s.src = "/live2d/core/live2d.min.js";
						s.onload = () => resolve();
						s.onerror = () => reject(new Error("live2d.min.js 加载失败"));
						document.head.appendChild(s);
					});
				}
				// 2) pixi + live2d 显示层（动态 import：SSR 无关、不进主 bundle）
				const pixi = await import("pixi.js");
				const { Live2DModel } = await import("pixi-live2d-display");
				// 库依赖 window.PIXI 暴露（Ticker / 注册表）
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

				// autoInteract 关掉：内置自动交互走 pixi 废弃的 interaction 插件会抛错
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const model = (await Live2DModel.from(
					"/live2d/shizuku/shizuku.model.json",
					{ autoInteract: false }
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				)) as any;
				if (disposed) {
					model.destroy?.();
					app.destroy(true);
					return;
				}
				// 按模型固有尺寸动态缩放（各模型分辨率差异大，写死系数必翻车）
				model.anchor.set(0.5, 1); // 底部中心 = 脚站地板
				model.scale.set(TARGET_H / model.height);
				model.position.set(ROOM_W * 0.54, FLOOR_TOP + 6);
				app.stage.addChild(model);
				appRef.current = app;
				modelRef.current = model;
				// 调试句柄：线上量几何用（只读无害）
				(window as unknown as { __wlistPetModel?: unknown }).__wlistPetModel =
					model;
				setMode("live2d");
			} catch (err) {
				console.warn("Live2D 加载失败，回退 SVG 小猫:", err);
				setMode("svg");
			}
		})();
		return () => {
			disposed = true;
		};
	}, [roomOpen, mode]);

	// 灵动时钟：每 18~40s 自己挑个动作玩（换表情，三成概率冒台词）
	useEffect(() => {
		if (mode !== "live2d") return;
		let timer: number | undefined;
		const tick = () => {
			timer = window.setTimeout(() => {
				playRandom();
				if (Math.random() < 0.35) poke();
				tick();
			}, 18_000 + Math.random() * 22_000);
		};
		tick();
		return () => window.clearTimeout(timer);
	}, [mode, playRandom, poke]);

	// 鼠标悬停 → 视线跟随
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

	if (roomOpen === null) return null; // SSR/首帧不渲染，避免闪烁

	// 回退：原守盘小猫（WebGL 不可用 / 模型加载失败）
	if (mode === "svg") {
		return <SitePet busy={busy} />;
	}

	const open = roomOpen === true;

	return (
		<div
			className={`fixed z-40 select-none transition-all duration-300 ${
				open
					? "bottom-4 right-4 overflow-hidden rounded-[28px] border-2 shadow-2xl"
					: "bottom-[84px] right-3 overflow-visible"
			}`}
			style={open ? { width: ROOM_W, height: ROOM_H } : { width: ROOM_W * FLOAT_SCALE, height: ROOM_H * FLOAT_SCALE }}
		>
			<style>{STYLE}</style>

			{/* 聊天面板（AI 已配置，从她左侧弹出；两种形态都以挂载点为锚） */}
			{chatOpen && aiConfigured && (
				<div className="petroom-panel-in absolute bottom-2 right-[calc(100%+0.75rem)] flex h-72 w-[16rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
					<div className="flex items-center justify-between border-b border-zinc-100 bg-gradient-to-r from-amber-50 to-orange-50 px-3 py-2 dark:border-zinc-800 dark:from-amber-950/30 dark:to-orange-950/20">
						<div className="flex items-center gap-1.5">
							<span className="text-xs" aria-hidden>
								🌸
							</span>
							<span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
								和看板娘聊天
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

			{/* 台词气泡（她头顶） */}
			{phrase && (
				<div
					className="petroom-bubble-in absolute left-1/2 z-20 w-max max-w-[12rem] -translate-x-1/2"
					style={
						open
							? { bottom: ROOM_H - (FLOOR_TOP - TARGET_H) - 26 }
							: { top: -42 }
					}
					role="status"
				>
					<div className="relative rounded-2xl border border-zinc-200 bg-white px-3.5 py-2 text-center text-[13px] text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
						{phrase}
					</div>
				</div>
			)}

			{/* ======== 房间装饰（仅展开态；画布缩放态她是悬浮的，无背景） ======== */}
			{open && (
				<>
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
						<g className="dark:hidden">
							<circle cx="52" cy="20" r="10" fill="#fbbf24" />
							<ellipse cx="26" cy="38" rx="12" ry="6" fill="#fff" opacity="0.9" />
							<ellipse cx="34" cy="35" rx="9" ry="5" fill="#fff" opacity="0.9" />
						</g>
						<g className="hidden dark:inline">
							<circle cx="50" cy="22" r="11" fill="#fde68a" />
							<circle cx="46" cy="19" r="9" fill="#1e293b" />
							<circle className="petroom-star" cx="18" cy="20" r="1.8" fill="#fef9c3" />
							<circle className="petroom-star" style={{ animationDelay: "0.9s" }} cx="30" cy="34" r="1.4" fill="#fef9c3" />
							<circle className="petroom-star" style={{ animationDelay: "1.7s" }} cx="16" cy="46" r="1.6" fill="#fef9c3" />
						</g>
						{busy && (
							<g className="hidden dark:inline">
								<line className="petroom-shooting" x1="64" y1="8" x2="72" y2="8" stroke="#fef08a" strokeWidth="2" strokeLinecap="round" />
							</g>
						)}
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
							background: "repeating-linear-gradient(90deg, #e7c9a9 0 34px, #dcb894 34px 68px)",
						}}
						aria-hidden="true"
					/>
					<div
						className="absolute inset-x-0 bottom-0 hidden border-t-4 border-amber-900/70 dark:block"
						style={{
							height: ROOM_H - FLOOR_TOP,
							background: "repeating-linear-gradient(90deg, #6b5340 0 34px, #5c4838 34px 68px)",
						}}
						aria-hidden="true"
					/>
				</>
			)}

			{/* ======== 画布（房间坐标系的绝对基准；悬浮态整体 CSS 缩小） ======== */}
			<div
				className="absolute left-0 top-0 origin-top-left"
				style={{
					width: ROOM_W,
					height: ROOM_H,
					// 悬浮态：缩到 0.55 且下移，让「脚底(内部 y=FLOOR_TOP+6)」贴住悬浮框底边
					// （房间地板以下那截空白不进入可视范围，人不悬空）
					transform: open
						? "none"
						: `scale(${FLOAT_SCALE}) translateY(${ROOM_H - (FLOOR_TOP + 6)}px)`,
				}}
			>
				<div
					ref={stageRef}
					className="relative cursor-pointer"
					style={{ width: ROOM_W, height: ROOM_H }}
					onPointerMove={onStagePointerMove}
					onClick={() => {
						// autoInteract 关闭后手动接点击：互动动作 + 随机表情 + 台词
						playRandom();
						poke();
					}}
					title="点点她？会有反应哦"
				/>
			</div>

			{/* 加载中 */}
			{mode === "loading" && (
				<div className="absolute inset-0 z-20 flex items-end justify-center pb-6">
					<span className="animate-pulse rounded-full bg-white/80 px-3 py-1 text-xs text-amber-600 shadow dark:bg-zinc-800/80 dark:text-amber-300">
						看板娘睡醒了穿衣服中…
					</span>
				</div>
			)}

			{/* 顶栏：展开态=名字/聊天/收起；悬浮态=小尺寸按钮组 */}
			{open ? (
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
							title="收起小窝（她还留在页面上）"
							onClick={toggleRoom}
							className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] text-zinc-500 backdrop-blur-sm transition-colors hover:bg-zinc-100 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:bg-zinc-700"
						>
							▾
						</button>
					</div>
				</div>
			) : (
				<div className="absolute -top-6 right-0 z-30 flex items-center gap-1">
					{aiConfigured && (
						<button
							type="button"
							title="和她聊天"
							onClick={() => {
								setChatOpen((o) => !o);
								window.setTimeout(() => inputRef.current?.focus(), 120);
							}}
							className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] shadow backdrop-blur-sm transition-colors hover:bg-pink-100 dark:bg-zinc-800/70 dark:hover:bg-pink-950/50"
						>
							💬
						</button>
					)}
					<button
						type="button"
						title="打开她的小窝"
						aria-label="打开守盘小窝"
						onClick={toggleRoom}
						className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] shadow backdrop-blur-sm transition-colors hover:bg-amber-100 dark:bg-zinc-800/70 dark:hover:bg-zinc-700"
					>
						🏠
					</button>
				</div>
			)}
		</div>
	);
}
