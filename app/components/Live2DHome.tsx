/**
 * 守盘看板娘：悬浮在页面右下角的 Live2D 形象（无房间装饰）
 * - 形象 / AI 开关由 home loader 服务端直读下发（无探测请求，出场快一步）
 * - 加载链并行化：runtime 脚本与渲染库同时拉，失败回退 SVG 守盘小猫（SitePet）
 * - 底座：发光椭圆台座（渐变+描边，日夜两套配色），人物站在上面不悬空
 * - 灵动性：待机动作自动播；每 18~40 秒随机挑动作/表情自己玩，35% 概率冒台词
 * - 点击=互动（随机动作+表情+台词）；鼠标划过视线跟随
 * - AI 配置后 💬 聊天面板，走 /api/pet 服务端代理（key 不出服务端）
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

/** 可选形象（key 与服务端 PET_MODELS 一致）。
 *  h = 目标身高（逻辑 px）：各模型包围盒内空白差异大，per-model 调节视觉大小 */
const MODEL_CATALOG = [
	{ key: "shizuku", file: "/live2d/shizuku/shizuku.model.json", gen: 2, h: 260 },
	{ key: "tororo", file: "/live2d/tororo/tororo.model3.json", gen: 4, h: 300 },
	{ key: "hijiki", file: "/live2d/hijiki/hijiki.model3.json", gen: 4, h: 300 },
	{ key: "rice", file: "/live2d/rice/rice_pro_t03.model3.json", gen: 4, h: 300 },
	{ key: "hiyori", file: "/live2d/hiyori/hiyori_free_t08.model3.json", gen: 4, h: 360 },
] as const;

const STYLE = `
@keyframes petstand-pulse {
	0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1); }
	50% { opacity: 0.9; transform: translateX(-50%) scale(1.04); }
}
@keyframes petstand-bubble-in {
	0% { opacity: 0; transform: translateY(6px) scale(0.85); }
	60% { opacity: 1; transform: translateY(-2px) scale(1.04); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes petstand-panel-in {
	0% { opacity: 0; transform: translateY(8px) scale(0.97); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
.petstand-pulse { animation: petstand-pulse 2.8s ease-in-out infinite; }
@keyframes petstand-twinkle {
	0%, 100% { opacity: 0.25; }
	50% { opacity: 1; }
}
.petstand-twinkle { animation: petstand-twinkle 2.2s ease-in-out infinite; }
.petstand-bubble-in { animation: petstand-bubble-in 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) 1 both; }
.petstand-panel-in { animation: petstand-panel-in 0.22s cubic-bezier(0.34, 1.4, 0.64, 1) 1 both; }
@media (prefers-reduced-motion: reduce) {
	.petstand-pulse,
	.petstand-twinkle,
	.petstand-bubble-in,
	.petstand-panel-in {
		animation: none !important;
	}
}
`;

/** 画布逻辑尺寸（人物坐标系）；悬浮态整体 CSS 缩小展示 */
const STAGE_W = 320;
const STAGE_H = 400;
const FEET_Y = STAGE_H - 18; // 脚底（站在底座上沿）
/** 悬浮形态整个画布的 CSS 缩放（0.72 → 最大的形象屏上约 240px 高） */
const FLOAT_SCALE = 0.72;

export default function Live2DHome({
	busy,
	modelKey,
	aiConfigured,
}: {
	busy?: boolean;
	/** home loader 服务端下发的形象 key（切换后刷新页面生效） */
	modelKey: string;
	/** home loader 服务端下发的 AI 是否已配置 */
	aiConfigured: boolean;
}) {
	// 'loading' = 决定用 Live2D 还是回退；'live2d' | 'svg'
	const [mode, setMode] = useState<"loading" | "live2d" | "svg">("loading");
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
	} | null>(null);
	// 模型清单解析出的可玩动作组 / 表情名（各模型差异大，加载时提取）
	const playGroupsRef = useRef<string[]>([]);
	const exprNamesRef = useRef<string[]>([]);
	/** 当前已触发加载的形象 key（防同 key 重复加载；cleanup 置空允许重载） */
	const loadedKeyRef = useRef<string | null>(null);

	const [chatOpen, setChatOpen] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const { messages, waiting, chatError, sendChat, clearChat } = usePetChat({
		skipProbe: true, // configured/形象均来自 SSR props，不再发探测请求
	});

	const poke = useCallback(() => {
		const pool = busy ? BUSY_PHRASES : PHRASES;
		setPhrase(pool[Math.floor(Math.random() * pool.length)]);
		window.clearTimeout(phraseTimer.current);
		phraseTimer.current = window.setTimeout(() => setPhrase(null), 3500);
	}, [busy]);

	const playRandom = useCallback(() => {
		const m = modelRef.current;
		if (!m) return;
		// 有动组（剔除 Idle——那是常驻待机）就随机挑一组，否则纯换表情
		const groups = playGroupsRef.current;
		if (groups.length > 0) {
			m.motion(groups[Math.floor(Math.random() * groups.length)]);
		}
		const exprs = exprNamesRef.current;
		if (exprs.length > 0) {
			m.expression(exprs[Math.floor(Math.random() * exprs.length)]);
		}
	}, []);

	// 卸载清理
	useEffect(() => {
		return () => {
			window.clearTimeout(phraseTimer.current);
			appRef.current?.destroy();
		};
	}, []);

	// 客户端首帧后加载模型（modelKey 来自 SSR props，无探测往返）。
	// 形象 key 变化时会重跑（管理员切形象 → 刷新后换人）。
	// 注意 mode 不进 deps：setMode('live2d') 若触发重跑，cleanup 会把刚建好的画布销毁
	useEffect(() => {
		if (loadedKeyRef.current === modelKey) return; // 这只已加载/加载中
		let disposed = false;
		loadedKeyRef.current = modelKey;
		(async () => {
			try {
				const cat =
					MODEL_CATALOG.find((c) => c.key === modelKey) ?? MODEL_CATALOG[0];
				// 1) 官方 runtime 与 2) 渲染库并行拉（原先串行多一个往返）：
				//    Cubism4 = live2dcubismcore（全局 Live2DCubismCore）；
				//    Cubism2 = live2d.min.js（全局 Live2D）。都自托管
				const w = window as unknown as {
					Live2D?: unknown;
					Live2DCubismCore?: unknown;
				};
				const runtimePromise =
					cat.gen === 4
						? w.Live2DCubismCore
							? Promise.resolve()
							: new Promise<void>((resolve, reject) => {
									const s = document.createElement("script");
									s.src = "/live2d/core/live2dcubismcore.min.js";
									s.onload = () => resolve();
									s.onerror = () =>
										reject(new Error("live2dcubismcore.min.js 加载失败"));
									document.head.appendChild(s);
								})
						: w.Live2D
							? Promise.resolve()
							: new Promise<void>((resolve, reject) => {
									const s = document.createElement("script");
									s.src = "/live2d/core/live2d.min.js";
									s.onload = () => resolve();
									s.onerror = () => reject(new Error("live2d.min.js 加载失败"));
									document.head.appendChild(s);
								});
				// 0.4.0 主入口是全量包会同时检查两代 runtime，必须按代别走子入口
				const libPromise = (async () => {
					const pixi = await import("pixi.js");
					const { Live2DModel } =
						cat.gen === 4
							? await import("pixi-live2d-display/cubism4")
							: await import("pixi-live2d-display/cubism2");
					// 库依赖 window.PIXI 暴露（Ticker / 注册表）
					(window as unknown as { PIXI: unknown }).PIXI = pixi;
					return { pixi, Live2DModel };
				})();
				const [, { pixi, Live2DModel }] = await Promise.all([
					runtimePromise,
					libPromise,
				]);
				if (disposed || !stageRef.current) return;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const PIXI = pixi as any;

				// 重跑（切形象）时清掉旧画布
				stageRef.current.replaceChildren();

				const app = new PIXI.Application({
					width: STAGE_W,
					height: STAGE_H,
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
				const model = (await Live2DModel.from(cat.file, {
					autoInteract: false,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				})) as any;
				if (disposed) {
					model.destroy?.();
					app.destroy(true);
					return;
				}
				// 按模型固有尺寸动态缩放 + per-model 目标身高（包围盒内空白差异大）
				model.anchor.set(0.5, 1); // 底部中心 = 站在底座上
				model.scale.set(cat.h / model.height);
				model.position.set(STAGE_W * 0.5, FEET_Y);
				app.stage.addChild(model);

				// 从模型清单提取可玩动组 / 表情名（cubism4 与 cubism2 的清单结构不同）
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const settings = (model.settings ?? {}) as any;
				const motionTable =
					settings.FileReferences?.Motions ?? settings.motions ?? {};
				playGroupsRef.current = Object.keys(motionTable).filter(
					(k) =>
						Array.isArray(motionTable[k]) &&
						motionTable[k].length > 0 &&
						k.toLowerCase() !== "idle"
				);
				const exprList =
					settings.FileReferences?.Expressions ?? settings.expressions ?? [];
				exprNamesRef.current = (Array.isArray(exprList) ? exprList : [])
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					.map((e: any) => e.Name ?? e.name)
					.filter((n: unknown): n is string => typeof n === "string");

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
			loadedKeyRef.current = null; // 允许下次重载
			// 重跑（切形象）时销毁旧 app
			appRef.current?.destroy();
			appRef.current = null;
			modelRef.current = null;
		};
	}, [modelKey]);

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

	// 回退：原守盘小猫（WebGL 不可用 / 模型加载失败）
	if (mode === "svg") {
		return <SitePet busy={busy} />;
	}

	const cat = MODEL_CATALOG.find((c) => c.key === modelKey) ?? MODEL_CATALOG[0];

	return (
		<div
			className="fixed right-3 bottom-2 z-40 select-none"
			style={{
				width: STAGE_W * FLOAT_SCALE,
				height: STAGE_H * FLOAT_SCALE,
			}}
		>
			<style>{STYLE}</style>

			{/* 底座：坐垫式发光台座（渐变垫面/绣线内圈/受光高光/呼吸光晕/缘边小星），人物踩在上沿 */}
			<div
				className="pointer-events-none absolute left-1/2 z-0 -translate-x-1/2"
				style={{
					bottom: 0,
					width: Math.round(cat.h * 0.5 * FLOAT_SCALE) * 2,
					height: Math.round(52 * FLOAT_SCALE),
				}}
				aria-hidden="true"
			>
				{/* 白天款 */}
				<svg viewBox="0 0 200 52" className="h-full w-full overflow-visible dark:hidden">
					<defs>
						<radialGradient id="petGlowD" cx="50%" cy="50%" r="50%">
							<stop offset="0%" stopColor="rgba(251,191,36,0.5)" />
							<stop offset="55%" stopColor="rgba(251,146,60,0.22)" />
							<stop offset="100%" stopColor="rgba(251,146,60,0)" />
						</radialGradient>
						<linearGradient id="petCushionD" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#fff7e3" />
							<stop offset="55%" stopColor="#fcd9a8" />
							<stop offset="100%" stopColor="#efab5e" />
						</linearGradient>
					</defs>
					{/* 地面软影 */}
					<ellipse cx="100" cy="47" rx="84" ry="4.5" fill="rgba(120,72,20,0.22)" />
					{/* 呼吸光晕 */}
					<ellipse className="petstand-pulse" cx="100" cy="30" rx="82" ry="16" fill="url(#petGlowD)" />
					{/* 坐垫主体 */}
					<ellipse cx="100" cy="30" rx="70" ry="13" fill="url(#petCushionD)" stroke="#e8973f" strokeWidth="1.6" />
					{/* 绣线内圈 */}
					<ellipse cx="100" cy="30" rx="54" ry="9" fill="none" stroke="#fffaf0" strokeWidth="1.1" strokeDasharray="5 4" opacity="0.95" />
					{/* 受光高光弧（左上） */}
					<path d="M 42 26 A 70 13 0 0 1 100 17.5" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2.2" strokeLinecap="round" />
					{/* 缘边小星 */}
					<circle className="petstand-twinkle" cx="38" cy="28" r="1.7" fill="#fff" />
					<circle className="petstand-twinkle" style={{ animationDelay: "1.1s" }} cx="163" cy="29" r="1.3" fill="#fff7ed" />
					<circle className="petstand-twinkle" style={{ animationDelay: "2s" }} cx="128" cy="21" r="1" fill="#fff" />
				</svg>
				{/* 夜晚款 */}
				<svg viewBox="0 0 200 52" className="hidden h-full w-full overflow-visible dark:block">
					<defs>
						<radialGradient id="petGlowN" cx="50%" cy="50%" r="50%">
							<stop offset="0%" stopColor="rgba(251,191,36,0.34)" />
							<stop offset="55%" stopColor="rgba(148,106,52,0.18)" />
							<stop offset="100%" stopColor="rgba(148,106,52,0)" />
						</radialGradient>
						<linearGradient id="petCushionN" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#4b4258" />
							<stop offset="55%" stopColor="#3a3344" />
							<stop offset="100%" stopColor="#2b2633" />
						</linearGradient>
					</defs>
					<ellipse cx="100" cy="47" rx="84" ry="4.5" fill="rgba(0,0,0,0.45)" />
					<ellipse className="petstand-pulse" cx="100" cy="30" rx="82" ry="16" fill="url(#petGlowN)" />
					<ellipse cx="100" cy="30" rx="70" ry="13" fill="url(#petCushionN)" stroke="#a97c3f" strokeWidth="1.6" />
					<ellipse cx="100" cy="30" rx="54" ry="9" fill="none" stroke="#e7c58f" strokeWidth="1.1" strokeDasharray="5 4" opacity="0.55" />
					<path d="M 42 26 A 70 13 0 0 1 100 17.5" fill="none" stroke="rgba(253,230,138,0.75)" strokeWidth="2.2" strokeLinecap="round" />
					<circle className="petstand-twinkle" cx="38" cy="28" r="1.7" fill="#fde68a" />
					<circle className="petstand-twinkle" style={{ animationDelay: "1.1s" }} cx="163" cy="29" r="1.3" fill="#fef3c7" />
					<circle className="petstand-twinkle" style={{ animationDelay: "2s" }} cx="128" cy="21" r="1" fill="#fde68a" />
				</svg>
			</div>

			{/* 聊天面板（AI 已配置，从她左侧弹出） */}
			{chatOpen && aiConfigured && (
				<div className="petstand-panel-in absolute bottom-4 right-[calc(100%+0.75rem)] flex h-72 w-[16rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
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

			{/* 台词气泡（头顶上方） */}
			{phrase && (
				<div
					className="petstand-bubble-in absolute left-1/2 z-20 w-max max-w-[12rem] -translate-x-1/2"
					style={{ top: -8 }}
					role="status"
				>
					<div className="relative rounded-2xl border border-zinc-200 bg-white px-3.5 py-2 text-center text-[13px] text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
						{phrase}
						<span className="absolute bottom-0 left-1/2 h-2.5 w-2.5 translate-y-1/2 rotate-45 border-b border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800" />
					</div>
				</div>
			)}

			{/* 画布（人物；缩放锚定左上，底部对齐底座） */}
			<div
				className="absolute left-0 top-0 origin-top-left"
				style={{
					width: STAGE_W,
					height: STAGE_H,
					transform: `scale(${FLOAT_SCALE}) translateY(${STAGE_H - (FEET_Y + 14)}px)`,
				}}
			>
				<div
					ref={stageRef}
					className="relative cursor-pointer"
					style={{ width: STAGE_W, height: STAGE_H }}
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
				<div className="absolute inset-x-0 bottom-6 z-20 flex justify-center">
					<span className="animate-pulse rounded-full bg-white/80 px-3 py-1 text-xs text-amber-600 shadow dark:bg-zinc-800/80 dark:text-amber-300">
						看板娘睡醒了穿衣服中…
					</span>
				</div>
			)}

			{/* 聊天入口（AI 已配置时） */}
			{aiConfigured && (
				<button
					type="button"
					title="和她聊天"
					onClick={() => {
						setChatOpen((o) => !o);
						window.setTimeout(() => inputRef.current?.focus(), 120);
					}}
					className="absolute right-1 top-1 z-30 rounded-full bg-white/70 px-2 py-0.5 text-xs shadow backdrop-blur-sm transition-colors hover:bg-pink-100 dark:bg-zinc-800/70 dark:hover:bg-pink-950/50"
				>
					💬
				</button>
			)}
		</div>
	);
}
