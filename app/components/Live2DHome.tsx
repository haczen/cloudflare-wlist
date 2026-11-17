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
import PetStand from "./PetStand";
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
 *  h = 目标身高（逻辑 px）：各模型包围盒内空白差异大，per-model 调节视觉大小；
 *  stand = 底座造型：cushion 坐垫 / nest 宠物小窝 */
const MODEL_CATALOG = [
	{ key: "shizuku", file: "/live2d/shizuku/shizuku.model.json", gen: 2, h: 260, stand: "cushion" },
	{ key: "tororo", file: "/live2d/tororo/tororo.model3.json", gen: 4, h: 270, stand: "nest" },
	{ key: "hijiki", file: "/live2d/hijiki/hijiki.model3.json", gen: 4, h: 270, stand: "nest" },
	{ key: "rice", file: "/live2d/rice/rice_pro_t03.model3.json", gen: 4, h: 300, stand: "cushion" },
	{ key: "hiyori", file: "/live2d/hiyori/hiyori_free_t08.model3.json", gen: 4, h: 390, stand: "cushion" },
] as const;

const STYLE = `
@keyframes petstand-bubble-in {
	0% { opacity: 0; transform: translateY(6px) scale(0.85); }
	60% { opacity: 1; transform: translateY(-2px) scale(1.04); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes petstand-panel-in {
	0% { opacity: 0; transform: translateY(8px) scale(0.97); }
	100% { opacity: 1; transform: translateY(0) scale(1); }
}
.petstand-bubble-in { animation: petstand-bubble-in 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) 1 both; }
.petstand-panel-in { animation: petstand-panel-in 0.22s cubic-bezier(0.34, 1.4, 0.64, 1) 1 both; }
@media (prefers-reduced-motion: reduce) {
	.petstand-bubble-in,
	.petstand-panel-in {
		animation: none !important;
	}
}
`;

/** 画布逻辑尺寸（人物坐标系）；悬浮态整体 CSS 缩小展示 */
const STAGE_W = 320;
const STAGE_H = 440;
const FEET_Y = STAGE_H - 20; // 脚底（站在底座上沿；日和 390 高 → 头顶 30 不裁）
/** 悬浮形态整个画布的 CSS 缩放（0.72 → 日和屏上约 281px 高） */
const FLOAT_SCALE = 0.72;

export default function Live2DHome({
	busy,
	modelKey,
	aiConfigured,
	dark,
}: {
	busy?: boolean;
	/** home loader 服务端下发的形象 key（切换后刷新页面生效） */
	modelKey: string;
	/** home loader 服务端下发的 AI 是否已配置 */
	aiConfigured: boolean;
	/** 站点当前主题（底座 Canvas 按此补间日夜调色板） */
	dark: boolean;
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
				// 不需要 pixi 内置事件系统（点击/视线跟随全由 React 层手动接）：
				// 留着它会在 pointer 事件里空转报 currentTarget.isInteractive 错
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(app.renderer as any).events?.destroy?.();
				} catch {
					/* 版本差异忽略 */
				}

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
				// 按模型固有尺寸动态缩放 + per-model 目标身高（包围盒内空白差异大）。
				// 宠物窝造型再下沉一点——脚和小腿埋进窝里，配合前檐遮挡形成"坐进去"的实感
				const sink = cat.stand === "nest" ? 18 : 0;
				model.anchor.set(0.5, 1); // 底部中心 = 落在底座上
				model.scale.set(cat.h / model.height);
				model.position.set(STAGE_W * 0.5, FEET_Y + sink);
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

	// 灵动时钟：动作与说话分开计时——
	// 动作（换表情/小舞蹈）每 10~22s 一次；说话每 14~28s 冒一句（不点击也会说）
	useEffect(() => {
		if (mode !== "live2d") return;
		let motionTimer: number | undefined;
		let speakTimer: number | undefined;
		let stopped = false;
		const loopMotion = () => {
			motionTimer = window.setTimeout(() => {
				if (stopped) return;
				playRandom();
				loopMotion();
			}, 10_000 + Math.random() * 12_000);
		};
		const loopSpeak = () => {
			speakTimer = window.setTimeout(() => {
				if (stopped) return;
				poke();
				loopSpeak();
			}, 14_000 + Math.random() * 14_000);
		};
		// 首句来得快一点（8s 内亮相，让人知道她会自己说话）
		speakTimer = window.setTimeout(() => {
			if (!stopped) {
				poke();
				loopSpeak();
			}
		}, 6_000 + Math.random() * 2_000);
		loopMotion();
		return () => {
			stopped = true;
			window.clearTimeout(motionTimer);
			window.clearTimeout(speakTimer);
		};
	}, [mode, playRandom, poke]);

	// 视线跟随：整页鼠标移动都算（不只画布内），rAF 节流
	useEffect(() => {
		if (mode !== "live2d") return;
		let raf = 0;
		let mx = -1;
		let my = -1;
		const onMove = (e: MouseEvent) => {
			mx = e.clientX;
			my = e.clientY;
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const m = modelRef.current;
				const stage = stageRef.current;
				if (!m || !stage || mx < 0) return;
				const r = stage.getBoundingClientRect();
				// 以人物胸口为原点，把屏幕坐标映射到 [-1,1]（右上为正）
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height * 0.5;
				const nx = Math.max(-1, Math.min(1, (mx - cx) / (window.innerWidth * 0.42)));
				const ny = Math.max(-1, Math.min(1, -(my - cy) / (window.innerHeight * 0.42)));
				m.focus(nx, ny);
			});
		};
		window.addEventListener("mousemove", onMove, { passive: true });
		return () => {
			window.removeEventListener("mousemove", onMove);
			if (raf) cancelAnimationFrame(raf);
		};
	}, [mode]);

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

			{/* 底座：Canvas 手绘（坐垫/宠物小窝；日夜调色板逐帧补间，小窝前檐盖过脚边） */}
			<PetStand
				width={Math.round(cat.h * FLOAT_SCALE * (cat.stand === "nest" ? 1.18 : 0.64))}
				height={cat.stand === "nest" ? 88 : 42}
				variant={cat.stand}
				dark={dark}
			/>

			{/* 聊天面板（入口常驻；未配置 AI 时展示接入指引） */}
			{chatOpen && (
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
						{!aiConfigured ? (
							<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
								还没接上 AI 大脑喵~
								<br />
								管理员可在「管理面板 → 看板娘 → AI 对话」
								<br />
								填入 API Key 后就能和她聊天了
							</p>
						) : (
							messages.length === 0 &&
							!waiting && (
								<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
									跟她打个招呼吧~
									<br />
									她知道这个站的各种玩法
								</p>
							)
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
							placeholder={aiConfigured ? "说点什么…" : "接入 AI 后才能聊天哦"}
							maxLength={500}
							value={chatInput}
							onChange={(e) => setChatInput(e.target.value)}
							disabled={!aiConfigured}
						/>
						<button
							type="submit"
							className="shrink-0 rounded-full bg-amber-400 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
							disabled={waiting || !chatInput.trim() || !aiConfigured}
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

			{/* 画布（人物；z-[5] 夹在底座背层 z-0 与小窝前檐 z-10 之间——猫狗坐进窝里） */}
			<div
				className="absolute left-0 top-0 z-[5] origin-top-left"
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

			{/* 聊天入口（常驻；未配置 AI 时窗口内给接入指引） */}
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
		</div>
	);
}
