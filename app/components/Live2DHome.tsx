/**
 * 守盘助手：悬浮在页面右下角的 Live2D 形象（无房间装饰）
 * - 形象 / AI 开关由 home loader 服务端直读下发（无探测请求，出场快一步）
 * - 加载链并行化：runtime 脚本与渲染库同时拉；加载期整体隐藏，失败自动重试（不换形象）
 * - 底座：发光椭圆台座（渐变+描边，日夜两套配色），人物站在上面不悬空
 * - 灵动性：待机动作自动播；每 18~40 秒随机挑动作/表情自己玩，35% 概率冒台词
 * - 点击=互动（随机动作+表情+台词）；鼠标划过视线跟随
 * - AI 配置后 💬 聊天面板，走 /api/pet 服务端代理（key 不出服务端）
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
	"点旁边的「和我聊天」按钮就能和我说话哦~",
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
	// dx = 水平重心校正（逻辑 px）：实测"人物像素质心 vs 画布中心"，
	// 饭团（rice）的包围盒内容整体偏右 70px，其余四只仅几像素
	{ key: "shizuku", file: "/live2d/shizuku/shizuku.model.json", gen: 2, h: 260, stand: "cushion", dx: -3 },
	{ key: "tororo", file: "/live2d/tororo/tororo.model3.json", gen: 4, h: 270, stand: "nest", dx: -5 },
	{ key: "hijiki", file: "/live2d/hijiki/hijiki.model3.json", gen: 4, h: 270, stand: "nest", dx: -4 },
	{ key: "rice", file: "/live2d/rice/rice_pro_t03.model3.json", gen: 4, h: 340, stand: "cushion", dx: -70 },
	{ key: "hiyori", file: "/live2d/hiyori/hiyori_free_t08.model3.json", gen: 4, h: 390, stand: "cushion", dx: -1 },
] as const;

/**
 * 首屏预加载清单。React 19 会把 <link rel="preload"> 提升到 <head>，所以这些标签
 * 随服务端渲染的 HTML 一起到达——浏览器在解析页面脚本的同时就把模型最大的几个文件
 * （运行时 + 骨架 + 贴图）拉下来了。否则要等 JS 启动、动态 import 完成后才开始请求，
 * 慢网络下这段时间人物迟迟出不来。
 */
const PRELOAD: Record<string, { runtime: string; files: string[] }> = {
	shizuku: {
		runtime: "/live2d/core/live2d.min.js",
		files: [
			"/live2d/shizuku/shizuku.moc",
			...Array.from({ length: 6 }, (_, i) => `/live2d/shizuku/shizuku.1024/texture_0${i}.png`),
		],
	},
	tororo: {
		runtime: "/live2d/core/live2dcubismcore.min.js",
		files: ["/live2d/tororo/tororo.moc3", "/live2d/tororo/tororo.2048/texture_00.png"],
	},
	hijiki: {
		runtime: "/live2d/core/live2dcubismcore.min.js",
		files: ["/live2d/hijiki/hijiki.moc3", "/live2d/hijiki/hijiki.2048/texture_00.png"],
	},
	rice: {
		runtime: "/live2d/core/live2dcubismcore.min.js",
		files: [
			"/live2d/rice/rice_pro_t03.moc3",
			"/live2d/rice/rice_pro_t03.2048/texture_00.png",
			"/live2d/rice/rice_pro_t03.2048/texture_01.png",
		],
	},
	hiyori: {
		runtime: "/live2d/core/live2dcubismcore.min.js",
		files: ["/live2d/hiyori/hiyori_free_t08.moc3", "/live2d/hiyori/hiyori_free_t08.2048/texture_00.png"],
	},
};

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
	userIdentity,
}: {
	busy?: boolean;
	/** home loader 服务端下发的形象 key（切换后刷新页面生效） */
	modelKey: string;
	/** home loader 服务端下发的 AI 是否已配置 */
	aiConfigured: boolean;
	/** 站点当前主题（底座 Canvas 按此补间日夜调色板） */
	dark: boolean;
	/** 登录身份（SPA 登录/登出后变化 → 聊天 hook 重新探测模式与剩余次数） */
	userIdentity?: string | null;
}) {
	// loading = 加载中（整体隐藏，不露空底座）｜live2d = 已就位｜failed = 多次重试仍失败
	const [mode, setMode] = useState<"loading" | "live2d" | "failed">("loading");
	/** 加载失败次数（自动重试用；换形象时归零） */
	const failCountRef = useRef(0);
	/** WebGL 上下文丢失自愈后强制重载模型用 */
	const [reloadNonce, setReloadNonce] = useState(0);
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
		/** 程序化动画用：transform 属性（pixi DisplayObject） */
		x: number;
		y: number;
		rotation: number;
		scale: { set: (v: number) => void };
	} | null>(null);
	// 模型清单解析出的可玩动作组 / 表情名（各模型差异大，加载时提取）
	const playGroupsRef = useRef<string[]>([]);
	const exprNamesRef = useRef<string[]>([]);
	/** 当前已触发加载的形象 key（防同 key 重复加载；cleanup 置空允许重载） */
	const loadedKeyRef = useRef<string | null>(null);

	const [chatOpen, setChatOpen] = useState(false);
	// 设置视图（切站内模型 / 接入自己的模型）
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [siteModels, setSiteModels] = useState<string[]>([]);
	const [siteModelsError, setSiteModelsError] = useState<string | null>(null);
	const [ownForm, setOwnForm] = useState({ baseUrl: "", apiKey: "", model: "" });
	const [ownModels, setOwnModels] = useState<string[]>([]);
	const [settingsBusy, setSettingsBusy] = useState(false);
	const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
	const [chatInput, setChatInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const {
		messages,
		waiting,
		chatError,
		sendChat,
		remaining,
		myMode,
		myModel,
		ownDirect,
		testOwn,
		connectOwn,
		disconnectOwn,
		refresh,
		clearChat,
	} = usePetChat({
			skipProbe: true, // configured/形象均来自 SSR props；模式与次数仍探测
			reprobeKey: userIdentity, // 登录/登出后重新探测
		});

	// ---- 助手位置（可拖拽；记忆在 localStorage） ----
	const PET_POS_KEY = "wlist-pet-pos";
	const [petPos, setPetPos] = useState<{ r: number; b: number } | null>(null);
	const dragMovedRef = useRef(false); // 拖过就不再当点击处理
	const lastTapRef = useRef(0); // 点击冷却时间戳
	/** 渲染循环心跳：ticker 每帧刷新；看门狗据此检测停摆 */
	const lastTickRef = useRef(0);
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(PET_POS_KEY) || "null");
			if (saved && typeof saved.r === "number" && typeof saved.b === "number") {
				// 夹回当前视口内：位置是按保存时的窗口尺寸算的绝对像素，
				// 窗口缩小（缩放/分屏/换了设备）后原值会把助手排到屏幕外=「消失」。
				// 注意上下边界必须按容器自身高度算（此前误用 60——拖到上方后
				// 容器顶部整段被排到屏幕外 = 「只显示一半」的根因）
				const w = STAGE_W * FLOAT_SCALE;
				const h = STAGE_H * FLOAT_SCALE;
				const r = Math.min(
					Math.max(4, saved.r),
					Math.max(4, window.innerWidth - w - 4)
				);
				const b = Math.min(
					Math.max(4, saved.b),
					Math.max(4, window.innerHeight - h - 4)
				);
				setPetPos({ r, b });
			}
		} catch {
			/* 损坏忽略 */
		}
	}, []);
	const onPetDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		const el = e.currentTarget.closest("div.fixed") as HTMLElement | null;
		if (!el) return;
		const startX = e.clientX;
		const startY = e.clientY;
		const rect = el.getBoundingClientRect();
		const startR = window.innerWidth - rect.right;
		const startB = window.innerHeight - rect.bottom;
		dragMovedRef.current = false;
		el.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			const dx = startX - ev.clientX;
			const dy = startY - ev.clientY;
			// 拖拽判定阈值：14px（原 6px 太敏感——真实点击时鼠标抖动常达 7-15px，
			// 会把每次"点击"误判成微型拖拽，助手被一点点挪走=「点几下人跑了」）
			if (Math.abs(dx) + Math.abs(dy) > 14) dragMovedRef.current = true;
			if (!dragMovedRef.current) return;
			const r = Math.min(
				Math.max(4, startR + dx),
				window.innerWidth - rect.width - 4
			);
			// 上界按容器高度算：b 最大 = 视口高 - 容器高 - 4（顶边贴住上沿），
			// 否则拖到上方后顶部被屏幕裁掉 = 只显示一半
			const b = Math.min(
				Math.max(4, startB + dy),
				window.innerHeight - rect.height - 4
			);
			setPetPos({ r, b });
		};
		const onUp = () => {
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			// pointer capture 会把后续 click 重定向到容器层——stage 的 onClick
			// 收不到。所以"点击"在这里判：按下后没拖动（<6px）= 互动
			if (!dragMovedRef.current) {
				// 连点冷却：350ms 内的重复点击不堆动作（狂点易把动画/GPU 打挂）
				const now = performance.now();
				if (now - lastTapRef.current < 350) return;
				lastTapRef.current = now;
				playRandom();
				poke();
				// 过半概率再送一个程序化小动作（跳/摇/弹），三成概率 600ms 后连招
				if (Math.random() < 0.55) flourish();
				if (Math.random() < 0.3) {
					window.setTimeout(() => playRandom(), 600);
				}
				return;
			}
			setPetPos((pos) => {
				if (pos) {
					try {
						localStorage.setItem(PET_POS_KEY, JSON.stringify(pos));
					} catch {
						/* 隐私模式忽略 */
					}
				}
				return pos;
			});
		};
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
	};

	// ---- 聊天面板：可拖拽 + 可缩放（记忆在 localStorage） ----
	const PANEL_KEY = "wlist-pet-panel";
	const [panel, setPanel] = useState<{
		x: number;
		y: number;
		w: number;
		h: number;
	} | null>(null);
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || "null");
			if (saved && saved.x >= 0 && saved.w >= 240) setPanel(saved);
		} catch {
			/* 损坏忽略 */
		}
	}, []);
	const savePanel = (p: typeof panel) => {
		setPanel(p);
		try {
			if (p) localStorage.setItem(PANEL_KEY, JSON.stringify(p));
		} catch {
			/* 隐私模式忽略 */
		}
	};
	const startPanelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		// 按钮上的按下不进入拖拽（否则 pointer-capture 会劫持走 ✕/🧹 的点击）
		if ((e.target as HTMLElement).closest("button")) return;
		const header = e.currentTarget;
		const panelEl = header.closest("div") as HTMLElement;
		const rect = panelEl.getBoundingClientRect();
		const fixed = panel ?? {
			x: rect.left,
			y: rect.top,
			w: rect.width,
			h: rect.height,
		};
		const startX = e.clientX;
		const startY = e.clientY;
		header.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			savePanel({
				...fixed,
				x: Math.min(
					Math.max(4, fixed.x + (ev.clientX - startX)),
					window.innerWidth - fixed.w - 4
				),
				y: Math.min(
					Math.max(4, fixed.y + (ev.clientY - startY)),
					window.innerHeight - 60
				),
			});
		};
		const onUp = () => {
			header.removeEventListener("pointermove", onMove);
			header.removeEventListener("pointerup", onUp);
		};
		header.addEventListener("pointermove", onMove);
		header.addEventListener("pointerup", onUp);
	};
	// 全向缩放：四条边 + 四个角。往哪拉就往哪个方向生长（左缘左拉变宽、
	// 右缘右拉变宽……），位置同步贴着被拉的方向移动
	const startPanelResize = (
		e: React.PointerEvent<HTMLDivElement>,
		dir: string // 如 "w"、"e"、"s"、"n"、"nw"、"ne"、"sw"、"se"
	) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		const grip = e.currentTarget;
		const panelEl = grip.parentElement as HTMLElement;
		const rect = panelEl.getBoundingClientRect();
		const fixed = panel ?? {
			x: rect.left,
			y: rect.top,
			w: rect.width,
			h: rect.height,
		};
		const startX = e.clientX;
		const startY = e.clientY;
		grip.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			const next = { ...fixed };
			if (dir.includes("w")) {
				next.w = Math.min(
					Math.max(240, fixed.w - dx),
					Math.min(560, window.innerWidth - 40)
				);
				// 左缘被拖动时右缘固定：x = 右缘 - 新宽（往左拉变宽、往右推变窄）
				next.x = Math.min(
					Math.max(4, fixed.x + (fixed.w - next.w)),
					window.innerWidth - next.w - 4
				);
			}
			if (dir.includes("e")) {
				next.w = Math.min(
					Math.max(240, fixed.w + dx),
					Math.min(560, window.innerWidth - fixed.x - 4)
				);
			}
			if (dir.includes("n")) {
				next.h = Math.min(
					Math.max(220, fixed.h - dy),
					Math.min(560, window.innerHeight - 40)
				);
				// 上缘被拖动时底缘固定：y = 底缘 - 新高
				next.y = Math.min(
					Math.max(4, fixed.y + (fixed.h - next.h)),
					window.innerHeight - next.h - 4
				);
			}
			if (dir.includes("s")) {
				next.h = Math.min(
					Math.max(220, fixed.h + dy),
					Math.min(560, window.innerHeight - fixed.y - 4)
				);
			}
			savePanel(next);
		};
		const onUp = () => {
			grip.removeEventListener("pointermove", onMove);
			grip.removeEventListener("pointerup", onUp);
		};
		grip.addEventListener("pointermove", onMove);
		grip.addEventListener("pointerup", onUp);
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
		// 动作/表情启动若抛错（异常数据/竞态）不能让异常逃逸——
		// 它会打断 pixi 渲染循环，画布从此空白=「人物消失」
		const groups = playGroupsRef.current;
		if (groups.length > 0) {
			try {
				m.motion(groups[Math.floor(Math.random() * groups.length)]);
			} catch (err) {
				console.warn("[守盘助手] 动作启动失败:", err);
			}
		}
		const exprs = exprNamesRef.current;
		if (exprs.length > 0) {
			try {
				m.expression(exprs[Math.floor(Math.random() * exprs.length)]);
			} catch (err) {
				console.warn("[守盘助手] 表情切换失败:", err);
			}
		}
	}, []);

	// ---- 程序化小动作：模型自带动作之外的自编动画（跳/摇/弹），所有形象通用 ----
	const basePoseRef = useRef<{ x: number; y: number; scale: number } | null>(null);
	const animRafRef = useRef<number | undefined>(undefined);
	const animTokenRef = useRef(0); // 新动画打断旧动画

	const runAnim = useCallback((fn: (p: number) => void, ms: number) => {
		const base = basePoseRef.current;
		if (!base || !modelRef.current) return;
		const token = ++animTokenRef.current;
		if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
		const t0 = performance.now();
		const step = (now: number) => {
			const m = modelRef.current;
			const b = basePoseRef.current;
			if (animTokenRef.current !== token || !m || !b) return;
			const p = Math.min(1, (now - t0) / ms);
			fn(p);
			if (p < 1) animRafRef.current = requestAnimationFrame(step);
		};
		animRafRef.current = requestAnimationFrame(step);
	}, []);

	/** 跳一下（离地 + 舒展 + 轻微回摆） */
	const hopAnim = useCallback(() => {
		runAnim((p) => {
			const m = modelRef.current;
			const b = basePoseRef.current;
			if (!m || !b) return;
			const lift = Math.sin(p * Math.PI);
			m.y = b.y - lift * 20;
			m.scale.set(b.scale * (1 + lift * 0.05));
			m.rotation = Math.sin(p * Math.PI * 2) * 0.03;
		}, 520);
	}, [runAnim]);

	/** 左右摇摆（绕脚底打摆子） */
	const swayAnim = useCallback(() => {
		runAnim((p) => {
			const m = modelRef.current;
			const b = basePoseRef.current;
			if (!m || !b) return;
			const env = Math.sin(p * Math.PI); // 两端收住
			m.rotation = Math.sin(p * Math.PI * 4) * 0.07 * env;
			m.x = b.x + Math.sin(p * Math.PI * 2) * 6 * env;
		}, 900);
	}, [runAnim]);

	/** 弹一弹（压扁→回弹） */
	const bounceAnim = useCallback(() => {
		runAnim((p) => {
			const m = modelRef.current;
			const b = basePoseRef.current;
			if (!m || !b) return;
			const k = Math.sin(p * Math.PI) * (1 - p * 0.25);
			m.scale.set(b.scale * (1 - 0.05 * k));
			m.y = b.y + 5 * k;
		}, 420);
	}, [runAnim]);

	/** 随机挑一个程序化小动作 */
	const flourish = useCallback(() => {
		const pick = Math.random();
		if (pick < 0.4) hopAnim();
		else if (pick < 0.75) swayAnim();
		else bounceAnim();
	}, [hopAnim, swayAnim, bounceAnim]);

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
		setMode("loading");
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
				// 独立 View Transition 快照组（.petstand-canvas）：主题圆形转场时
				// WebGL 像素回读不进全页截图，转场不掉帧
				canvas.className = "petstand-canvas";
				stageRef.current.appendChild(canvas);
				// 渲染心跳：看门狗据此判断循环是否停摆
				lastTickRef.current = performance.now();
				app.ticker.add(() => {
					lastTickRef.current = performance.now();
				});
				// WebGL 上下文丢失（GPU 驱动回收/负载高时偶发）→ 画布变空白像「消失」；
				// 阻止默认丢渲染，恢复事件里强制重载模型
				canvas.addEventListener(
					"webglcontextlost",
					(e) => e.preventDefault(),
					false
				);
				canvas.addEventListener(
					"webglcontextrestored",
					() => setReloadNonce((n) => n + 1),
					false
				);
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
				// 缩放只算一次存进变量——model.height 是"乘以 scale 后"的派生值，
				// set 之后再读会拿到 340（已缩小的），340/340=1.0 存进 basePose →
				// 程序化动画一触发模型就弹回全尺寸（4500px）=「变大后看不见」的真凶
				const baseScale = cat.h / model.height;
				model.scale.set(baseScale);
				model.position.set(STAGE_W * 0.5 + cat.dx, FEET_Y + sink);
				app.stage.addChild(model);

				// 从模型清单提取可玩动组 / 表情名（cubism4 与 cubism2 的清单结构不同）
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				// 动组/表情清单在 internalModel.settings 上（model.settings 是空的）
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const settings = ((model as any).internalModel?.settings ??
					(model as any).settings ??
					{}) as any;
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
				// 程序化动作的基准姿态（模型自带动作之外的自编小动作：跳/摇/弹）
				basePoseRef.current = {
					x: STAGE_W * 0.5 + cat.dx,
					y: FEET_Y + sink,
					scale: baseScale, // 用上面只算一次的值（此刻 model.height 已是缩小后的）
				};
				// 调试句柄：线上量几何用（只读无害）
				(window as unknown as { __wlistPetModel?: unknown }).__wlistPetModel =
					model;
				failCountRef.current = 0;
				setMode("live2d");
			} catch (err) {
				console.warn("[守盘助手] 形象加载失败:", err);
				// 不换回别的形象（用户选了谁就是谁）：网络抖动很常见，退避后自动重试
				const attempt = ++failCountRef.current;
				if (attempt <= 5) {
					window.setTimeout(() => {
						if (!disposed) setReloadNonce((n) => n + 1);
					}, Math.min(1500 * (2 ** (attempt - 1)), 24000));
				} else {
					setMode("failed");
				}
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
	}, [modelKey, reloadNonce]);

	// 渲染看门狗：ticker 心跳停超 3s（异常打断了渲染循环 = 人物消失的已知病理）→
	// 自动重载模型自愈；页面在后台时 rAF 本来就停，跳过
	useEffect(() => {
		if (mode !== "live2d") return;
		const id = window.setInterval(() => {
			if (document.hidden) return;
			if (!appRef.current || !lastTickRef.current) return;
			if (performance.now() - lastTickRef.current > 3000) {
				console.warn("[守盘助手] 渲染循环停摆，自动重载模型");
				setReloadNonce((n) => n + 1);
			}
		}, 2000);
		return () => window.clearInterval(id);
	}, [mode]);

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
				if (Math.random() < 0.4) flourish();
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

	const cat = MODEL_CATALOG.find((c) => c.key === modelKey) ?? MODEL_CATALOG[0];

	return (
		<div
			className={`fixed z-40 select-none transition-opacity duration-300 ${
				mode === "loading" ? "pointer-events-none opacity-0" : "opacity-100"
			}`}
			style={{
				right: petPos ? petPos.r : 12,
				bottom: petPos ? petPos.b : 8,
				width: STAGE_W * FLOAT_SCALE,
				height: STAGE_H * FLOAT_SCALE,
			}}
		>
			<style>{STYLE}</style>

			{/* 首屏预加载：服务端渲染阶段就下发，模型文件与页面脚本并行下载（React 19 自动提升到 head） */}
			{mode === "loading" &&
				PRELOAD[cat.key]?.files.map((href) => (
					<link key={href} rel="preload" href={href} as="fetch" />
				))}
			{mode === "loading" && PRELOAD[cat.key] && (
				<link rel="preload" href={PRELOAD[cat.key].runtime} as="script" />
			)}

			{/* 底座：Canvas 手绘（坐垫/宠物小窝；日夜调色板逐帧补间，小窝前檐盖过脚边） */}
			<PetStand
				width={Math.round(cat.h * FLOAT_SCALE * (cat.stand === "nest" ? 1.04 : 0.64))}
				height={cat.stand === "nest" ? 76 : 42}
				variant={cat.stand}
				dark={dark}
			/>

			{/* 聊天面板：入口常驻；标题栏拖拽、左下角把手缩放，位置尺寸记忆。
			    未拖拽过时默认停靠在助手左侧 */}
			{chatOpen && (
				<div
					className={
						panel
							? "petstand-panel-in fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
							: "petstand-panel-in absolute bottom-4 right-[calc(100%+0.75rem)] flex h-72 w-[16rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
					}
					style={
						panel
							? { left: panel.x, top: panel.y, width: panel.w, height: panel.h }
							: undefined
					}
				>
					<div
						className="flex cursor-grab items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2 active:cursor-grabbing dark:border-zinc-800 dark:bg-zinc-800/60"
						onPointerDown={startPanelDrag}
						title="按住拖动窗口位置"
					>
						<div className="flex items-center gap-1.5">
							<span className="text-xs" aria-hidden>
								🌸
							</span>
							<span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
								和守盘助手聊天
							</span>
						</div>
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								title="模型设置（切站内模型 / 接入自己的模型）"
								className={`rounded p-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 ${
									settingsOpen ? "bg-amber-100 dark:bg-amber-900/40" : ""
								}`}
								onClick={() => {
									const next = !settingsOpen;
									setSettingsOpen(next);
									// 打开时顺手拉一次站内模型清单（与当前用哪种模式无关）；
									// 失败把原因亮出来，不再永远「加载中」
									if (next && aiConfigured && siteModels.length === 0 && !siteModelsError) {
										setSiteModelsError(null);
										void fetch("/api/pet?models=1")
											.then(async (r) => {
												const d = (await r.json().catch(() => null)) as {
													models?: string[];
													error?: string;
												} | null;
												if (!r.ok || !d?.models)
													throw new Error(d?.error || "拉取失败");
												setSiteModels(d.models);
											})
											.catch((e) =>
												setSiteModelsError(
													e instanceof Error ? e.message : "拉取失败"
												)
											);
									}
								}}
							>
								⚙
							</button>
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
					{/* 全向缩放把手：四条边 + 四个角，往哪拉往哪长 */}
					<div className="absolute bottom-2 left-0 top-9 z-10 w-1.5 cursor-ew-resize" title="拖动调宽度" onPointerDown={(e) => startPanelResize(e, "w")} />
					<div className="absolute bottom-2 right-0 top-9 z-10 w-1.5 cursor-ew-resize" title="拖动调宽度" onPointerDown={(e) => startPanelResize(e, "e")} />
					<div className="absolute inset-x-2 bottom-0 z-10 h-1.5 cursor-ns-resize" title="拖动调高度" onPointerDown={(e) => startPanelResize(e, "s")} />
					<div className="absolute inset-x-2 top-8 z-10 h-1.5 cursor-ns-resize" title="拖动调高度" onPointerDown={(e) => startPanelResize(e, "n")} />
					<div className="absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize" onPointerDown={(e) => startPanelResize(e, "sw")} />
					<div className="absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize" onPointerDown={(e) => startPanelResize(e, "se")} />
					<div className="absolute left-0 top-8 z-20 h-4 w-4 cursor-nwse-resize" onPointerDown={(e) => startPanelResize(e, "nw")} />
					<div className="absolute right-0 top-8 z-20 h-4 w-4 cursor-nesw-resize" onPointerDown={(e) => startPanelResize(e, "ne")} />
					<div
						ref={listRef}
						className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5"
					>
						{settingsOpen ? (
							/* ---- ⚙ 设置：切站内模型 / 接入自己的模型（人设提示词只有管理员能看，这里不出现） ---- */
							<div className="flex flex-col gap-3 text-[11.5px]">
								{myMode === null ? (
									<p className="py-3 text-center leading-relaxed text-zinc-400">
										登录后可以切换站内模型、
										<br />
										或接入自己的模型无限畅聊
									</p>
								) : (
									<>
										{/* 站内模型 */}
										<div>
											<p className="mb-1 font-semibold text-zinc-700 dark:text-zinc-200">
												站内模型{myMode === "site" ? "（当前使用）" : ""}
											</p>
											{!aiConfigured ? (
												<p className="text-zinc-400">
													站内未配置——在下面接入自己的模型就能聊
												</p>
											) : siteModelsError ? (
												<p className="leading-relaxed text-red-600 dark:text-red-400">
													{siteModelsError}。
													<span className="text-zinc-500 dark:text-zinc-400">
														可直接在下面「接入自己的模型」——浏览器直连你的接口，不受此限制
													</span>
												</p>
											) : siteModels.length === 0 ? (
												<p className="text-zinc-400">加载中…（再点一次 ⚙ 刷新）</p>
											) : (
												<div className="flex flex-wrap gap-1">
													{siteModels.map((id) => (
														<button
															key={id}
															type="button"
															className={`rounded-full border px-2 py-0.5 font-mono text-[11px] transition ${
																myMode === "site" && myModel === id
																	? "border-amber-500 bg-amber-50 font-semibold text-amber-700 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
																	: "border-zinc-200 text-zinc-600 hover:border-amber-300 hover:text-amber-600 dark:border-zinc-700 dark:text-zinc-300"
															}`}
															disabled={settingsBusy}
															onClick={async () => {
																setSettingsBusy(true);
																setSettingsMsg(null);
																try {
																	const r = await fetch("/api/pet", {
																		method: "PUT",
																		headers: { "Content-Type": "application/json" },
																		body: JSON.stringify({ mySiteModel: id }),
																	});
																	const d = (await r.json().catch(() => ({}))) as { error?: string };
																	if (!r.ok) throw new Error(d.error || "切换失败");
																	refresh();
																	setSettingsMsg(`已切换站内模型：${id}`);
																} catch (err) {
																	setSettingsMsg(err instanceof Error ? err.message : "切换失败");
																} finally {
																	setSettingsBusy(false);
																}
															}}
														>
															{id}
															{myMode === "site" && myModel === id ? " ✓" : ""}
														</button>
													))}
												</div>
											)}
										</div>
										{/* 接入自己的模型：只要「API 地址 + Key」对就能用——请求由浏览器直连用户自己的接口 */}
										<div className="rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-700">
											<p className="mb-0.5 font-semibold text-zinc-700 dark:text-zinc-200">
												接入自己的模型{myMode === "own" ? "（当前使用 · 无限畅聊）" : ""}
											</p>
											<p className="mb-2 text-[10.5px] leading-relaxed text-zinc-400">
												填 API 地址和 Key 就行，模型从清单里选。请求由你的浏览器直接发到你的接口
												（和本地工具同一条路，不限次数）；Key 只存在你这个浏览器里。
											</p>
											<form
												className="flex flex-col gap-2"
												onSubmit={async (e) => {
													e.preventDefault();
													setSettingsBusy(true);
													setSettingsMsg(null);
													try {
														const key = ownForm.apiKey.trim() || ownDirect?.apiKey || "";
														if (!/^https?:\/\//.test(ownForm.baseUrl.trim())) {
															throw new Error("API 地址不合法（需 http(s):// 开头）");
														}
														if (!key) throw new Error("API Key 必填");
														const saved = await connectOwn({
															baseUrl: ownForm.baseUrl,
															apiKey: key,
															model: ownForm.model,
														});
														setSettingsMsg(
															`✓ 已接入${saved.model ? `（${saved.model}）` : ""}，无限畅聊开始！`
														);
														setOwnForm((f) => ({ ...f, apiKey: "" }));
													} catch (err) {
														setSettingsMsg("✗ " + (err instanceof Error ? err.message : "保存失败"));
													} finally {
														setSettingsBusy(false);
													}
												}}
											>
												<label className="block">
													<span className="mb-0.5 block text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
														API 地址（一般以 /v1 结尾）
													</span>
													<input
														className="input !py-1 !text-[11.5px]"
														placeholder="https://api.deepseek.com/v1"
														value={ownForm.baseUrl}
														onChange={(e) => setOwnForm((f) => ({ ...f, baseUrl: e.target.value }))}
													/>
												</label>
												<label className="block">
													<span className="mb-0.5 block text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
														API Key（sk- 开头；已接入过可留空沿用）
													</span>
													<input
														className="input !py-1 !text-[11.5px]"
														type="password"
														placeholder="sk-…"
														autoComplete="off"
														value={ownForm.apiKey}
														onChange={(e) => setOwnForm((f) => ({ ...f, apiKey: e.target.value }))}
													/>
												</label>
												<button
													type="button"
													className="btn-outline !py-1 !text-[11px]"
													disabled={settingsBusy}
													onClick={async () => {
														setSettingsBusy(true);
														setSettingsMsg("正在从你的浏览器测试连通…");
														try {
															const key = ownForm.apiKey.trim() || ownDirect?.apiKey || "";
															if (!ownForm.baseUrl.trim() || !key) {
																throw new Error("先填 API 地址和 API Key");
															}
															const out = await testOwn(ownForm.baseUrl, key);
															if ("error" in out) throw new Error(out.error);
															setOwnModels(out.models);
															// 没选模型时自动用清单第一个
															if (!ownForm.model && out.models[0]) {
																setOwnForm((f) => ({ ...f, model: out.models[0] }));
															}
															// 沿用的旧 Key 写回表单，保存时才带得上
															if (!ownForm.apiKey.trim()) {
																setOwnForm((f) => ({ ...f, apiKey: key }));
															}
															setSettingsMsg(
																out.models.length > 0
																	? `✓ 连通！共 ${out.models.length} 个模型，已帮你选好第一个（可改）`
																	: "✓ 连通，但这个接口没返回模型清单：请手动填模型名"
															);
														} catch (err) {
															setSettingsMsg("✗ " + (err instanceof Error ? err.message : "测试失败"));
														} finally {
															setSettingsBusy(false);
														}
													}}
												>
													{settingsBusy ? "测试中…" : "🔍 测试并获取模型"}
												</button>
												{ownModels.length > 0 && (
													<div>
														<span className="mb-0.5 block text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
															选一个模型（点名字填入）
														</span>
														<div className="flex flex-wrap gap-1">
															{ownModels.map((id) => (
																<button
																	key={id}
																	type="button"
																	className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
																		ownForm.model === id
																			? "border-accent-500 bg-accent-50 font-semibold text-accent-700 dark:bg-accent-950/40 dark:text-accent-300"
																			: "border-zinc-200 text-zinc-600 hover:border-accent-300 dark:border-zinc-700 dark:text-zinc-300"
																	}`}
																	onClick={() => setOwnForm((f) => ({ ...f, model: id }))}
																>
																	{id}
																</button>
															))}
														</div>
													</div>
												)}
												<label className="block">
													<span className="mb-0.5 block text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
														模型名（可不填：自动用清单里第一个）
													</span>
													<input
														className="input !py-1 !text-[11.5px]"
														placeholder="deepseek-chat"
														value={ownForm.model}
														onChange={(e) => setOwnForm((f) => ({ ...f, model: e.target.value }))}
													/>
												</label>
												<div className="flex gap-1.5">
													<button
														type="submit"
														className="btn-primary flex-1 !py-1 !text-[11px]"
														disabled={settingsBusy}
													>
														{settingsBusy ? "处理中…" : "保存并启用（无限畅聊）"}
													</button>
													{myMode === "own" && (
														<button
															type="button"
															className="btn-danger flex-1 !py-1 !text-[11px]"
															disabled={settingsBusy}
															onClick={async () => {
																setSettingsBusy(true);
																try {
																	await disconnectOwn();
																	setSettingsMsg("已断开自己的模型，回到站内模型");
																	setOwnModels([]);
																	setOwnForm({ baseUrl: "", apiKey: "", model: "" });
																} finally {
																	setSettingsBusy(false);
																}
															}}
														>
															断开
														</button>
													)}
												</div>
											</form>
										</div>
									</>
								)}
								{settingsMsg && (
									<p className="rounded-lg bg-zinc-100 px-2 py-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
										{settingsMsg}
									</p>
								)}
							</div>
						) : !aiConfigured && !ownDirect ? (
							<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
								还没接上 AI 大脑喵~
								<br />
								管理员可在「管理面板 → 守盘助手 → AI 对话」
								<br />
								填入 API Key 后就能和她聊天了
								<span className="mt-1 block">
									（或 ⚙ 里接入自己的模型，不需要站内配置）
								</span>
							</p>
						) : myMode === null ? (
							<p className="py-3 text-center text-[11px] leading-relaxed text-zinc-400">
								登录后才能和她聊天哦~
								<br />
								右上角登录，每个账号可聊 5 次
								<br />
								（⚙ 接入自己的模型可无限畅聊）
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
						className="flex flex-col gap-1 border-t border-zinc-100 p-2 dark:border-zinc-800"
						onSubmit={(e) => {
							e.preventDefault();
							sendChat(chatInput);
							setChatInput("");
						}}
					>
						<div className="flex items-center gap-1.5">
							<input
								ref={inputRef}
								className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[12.5px] text-zinc-800 outline-none focus:border-accent-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-accent-500"
								placeholder={
									myMode === null
										? "登录后才能聊天哦~"
										: !aiConfigured && !ownDirect
											? "接入 AI 后才能聊天哦（或点 ⚙ 接入自己的模型）"
											: remaining === 0
												? "聊天次数用完啦~（⚙ 里接入自己的模型可无限聊）"
												: "说点什么…"
								}
								maxLength={500}
								value={chatInput}
								onChange={(e) => setChatInput(e.target.value)}
								disabled={
									myMode === null || (!aiConfigured && !ownDirect) || remaining === 0
								}
							/>
							<button
								type="submit"
								className="shrink-0 rounded-full bg-accent-500 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-50"
								disabled={
									waiting ||
									!chatInput.trim() ||
									myMode === null ||
									(!aiConfigured && !ownDirect) ||
									remaining === 0
								}
							>
								发送
							</button>
						</div>
						{/* 剩余次数：无限（-1）= 管理员或已接入自己的模型 */}
						<p className="px-1 text-center text-[10.5px] text-zinc-400 dark:text-zinc-500">
							{myMode === null
								? "登录后才能和她聊天（每账号 5 次）"
								: !aiConfigured && !ownDirect
									? "未接入 AI"
									: remaining === -1
										? ownDirect
											? "∞ 无限畅聊（直连你自己的接口）"
											: "∞ 无限畅聊"
										: remaining === 0
											? "聊天次数已用完（共 5 次；⚙ 接入自己的模型可无限聊）"
											: `还可以聊 ${remaining ?? "…"} 次（共 5 次）`}
						</p>
					</form>
				</div>
			)}

			{/* 台词气泡（头顶上方、靠左排布——右边界止步于「和我聊天」按钮之前，不重叠） */}
			{phrase && (
				<div
					className="petstand-bubble-in absolute z-20 w-max"
					style={{ top: -10, left: -10, maxWidth: "calc(100% - 6.5rem)" }}
					role="status"
				>
					<div className="relative rounded-2xl border border-zinc-200 bg-white px-3.5 py-2 text-center text-[13px] text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
						{phrase}
						<span className="absolute bottom-0 left-[60%] h-2.5 w-2.5 translate-y-1/2 rotate-45 border-b border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800" />
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
					className="relative cursor-grab active:cursor-grabbing"
					style={{ width: STAGE_W, height: STAGE_H }}
					onPointerDown={onPetDragStart}
					// 点击互动在 onPetDragStart 的 pointerup 里判（按下未拖 = 点击）——
					// pointer capture 重定向后这里的 onClick 收不到事件
					title="点她有反应 · 按住可以拖到别处"
				/>
			</div>

			{/* 加载中 */}
			{/* 加载中：整个容器透明（不露空底座、不露加载字样），就位后淡入。
			    多次自动重试仍失败才给一个可点的小提示——绝不换回别的形象 */}
			{mode === "failed" && (
				<button
					type="button"
					className="absolute inset-x-0 bottom-6 z-20 mx-auto block rounded-full bg-white/90 px-3 py-1 text-xs text-zinc-600 shadow dark:bg-zinc-800/90 dark:text-zinc-300"
					onClick={() => {
						failCountRef.current = 0;
						setMode("loading");
						setReloadNonce((n) => n + 1);
					}}
				>
					守盘助手加载不出来 · 点这里重试
				</button>
			)}

			{/* 聊天入口（常驻、醒目；跟着助手走） */}
			<button
				type="button"
				title="和守盘助手聊天"
				onClick={() => {
					setChatOpen((o) => !o);
					window.setTimeout(() => inputRef.current?.focus(), 120);
				}}
				className="absolute right-0 top-0 z-30 flex items-center gap-1 rounded-full border border-accent-300/70 bg-white/90 px-3 py-1.5 text-xs font-semibold text-accent-600 shadow-lg backdrop-blur transition hover:bg-accent-50 active:scale-95 dark:border-accent-700 dark:bg-zinc-800/90 dark:text-accent-300 dark:hover:bg-accent-950/40"
			>
				<span className="text-sm" aria-hidden>
					💬
				</span>
				和我聊天
			</button>
		</div>
	);
}
