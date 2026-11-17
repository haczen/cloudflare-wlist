/**
 * 看板娘底座（Canvas 2D 手绘）
 * - 两种造型：cushion 坐垫式台座 / nest 宠物小窝（篮筐+软垫+前檐，前檐画在上层
 *   canvas 盖过人物脚边，形成"坐进窝里"的层次）
 * - 日夜不是两套图切换，而是调色板逐帧补间（治主题切换死板）；呼吸光晕/闪星常驻
 * - DPR 自适应保证高清；prefers-reduced-motion 时静帧
 */
import { useEffect, useRef } from "react";

type Variant = "cushion" | "nest";
/** 颜色一律 [r,g,b,a]，便于日夜补间 */
type RGBA = [number, number, number, number];
interface Palette {
	shadow: RGBA;
	glowA: RGBA;
	glowB: RGBA;
	top: RGBA;
	mid: RGBA;
	bottom: RGBA;
	rim: RGBA;
	stitch: RGBA;
	hl: RGBA;
	cushionA: RGBA;
	cushionB: RGBA;
	paw: RGBA;
	weave: RGBA;
}

const CUSHION_DAY: Palette = {
	shadow: [120, 72, 20, 0.22],
	glowA: [251, 191, 36, 0.5],
	glowB: [251, 146, 60, 0.2],
	top: [255, 247, 227, 1],
	mid: [252, 217, 168, 1],
	bottom: [239, 171, 94, 1],
	rim: [232, 151, 63, 1],
	stitch: [255, 250, 240, 0.95],
	hl: [255, 255, 255, 0.9],
	cushionA: [255, 244, 220, 1],
	cushionB: [246, 205, 150, 1],
	paw: [224, 138, 165, 1],
	weave: [214, 148, 84, 0.5],
};
const CUSHION_NIGHT: Palette = {
	shadow: [0, 0, 0, 0.45],
	glowA: [251, 191, 36, 0.3],
	glowB: [148, 106, 52, 0.14],
	top: [75, 66, 88, 1],
	mid: [58, 51, 68, 1],
	bottom: [43, 38, 51, 1],
	rim: [169, 124, 63, 1],
	stitch: [231, 197, 143, 0.55],
	hl: [253, 230, 138, 0.7],
	cushionA: [82, 70, 92, 1],
	cushionB: [52, 44, 62, 1],
	paw: [199, 154, 176, 0.9],
	weave: [150, 116, 78, 0.4],
};
const NEST_DAY: Palette = {
	shadow: [110, 66, 24, 0.26],
	glowA: [251, 191, 36, 0.42],
	glowB: [244, 131, 86, 0.18],
	top: [233, 186, 129, 1],
	mid: [207, 143, 85, 1],
	bottom: [166, 100, 54, 1],
	rim: [156, 95, 48, 1],
	stitch: [255, 240, 214, 0.8],
	hl: [255, 235, 200, 0.85],
	cushionA: [255, 235, 242, 1],
	cushionB: [244, 196, 211, 1],
	paw: [224, 118, 148, 1],
	weave: [150, 100, 55, 0.55],
};
const NEST_NIGHT: Palette = {
	shadow: [0, 0, 0, 0.5],
	glowA: [251, 191, 36, 0.24],
	glowB: [150, 108, 60, 0.12],
	top: [92, 80, 96, 1],
	mid: [72, 62, 76, 1],
	bottom: [52, 45, 58, 1],
	rim: [138, 106, 69, 1],
	stitch: [231, 197, 143, 0.4],
	hl: [253, 230, 138, 0.55],
	cushionA: [94, 78, 92, 1],
	cushionB: [64, 53, 68, 1],
	paw: [190, 140, 162, 0.9],
	weave: [120, 96, 70, 0.45],
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [
	lerp(a[0], b[0], t),
	lerp(a[1], b[1], t),
	lerp(a[2], b[2], t),
	lerp(a[3], b[3], t),
];
const css = (c: RGBA) =>
	`rgba(${c[0].toFixed(0)},${c[1].toFixed(0)},${c[2].toFixed(0)},${c[3].toFixed(3)})`;

export default function PetStand({
	width,
	height,
	variant,
	dark,
}: {
	width: number;
	height: number;
	variant: Variant;
	dark: boolean;
}) {
	const backRef = useRef<HTMLCanvasElement | null>(null);
	const frontRef = useRef<HTMLCanvasElement | null>(null);
	// 日夜混合进度：0=昼 1=夜；每帧向目标缓动
	const mixRef = useRef(dark ? 1 : 0);

	useEffect(() => {
		mixRef.current = dark ? 1 : 0;
	}, []); // 挂载瞬 Snap 到当前主题，不做开场动画

	useEffect(() => {
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const back = backRef.current;
		const front = frontRef.current;
		if (!back) return;
		const setup = (c: HTMLCanvasElement | null) => {
			if (!c) return null;
			c.width = Math.round(width * dpr);
			c.height = Math.round(height * dpr);
			const ctx = c.getContext("2d");
			if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			return ctx;
		};
		const bctx = setup(back);
		const fctx = setup(front);

		const draw = (timeMs: number) => {
			if (!bctx) return;
			const target = dark ? 1 : 0;
			const m = mixRef.current;
			const pal: Palette = {} as Palette;
			for (const k of Object.keys(CUSHION_DAY) as Array<keyof Palette>) {
				const day = variant === "nest" ? NEST_DAY[k] : CUSHION_DAY[k];
				const night = variant === "nest" ? NEST_NIGHT[k] : CUSHION_NIGHT[k];
				pal[k] = mix(day, night, m);
			}
			const phase = reduced ? 0 : timeMs / 1000;
			const breath = reduced ? 0.8 : 0.72 + 0.28 * Math.sin(phase * 2.1);
			bctx.clearRect(0, 0, width, height);
			if (fctx) fctx.clearRect(0, 0, width, height);

			const cx = width / 2;
			if (variant === "cushion") {
				drawCushion(bctx, cx, width, height, pal, breath, phase, reduced);
			} else {
				drawNestBack(bctx, cx, width, height, pal, breath, phase, reduced);
				if (fctx) drawNestFront(fctx, cx, width, height, pal);
			}
		};

		if (reduced) {
			// 静帧：主题切换时也只补间一瞬（直接跳到位）
			mixRef.current = dark ? 1 : 0;
			draw(0);
			return;
		}
		let raf = 0;
		let last = performance.now();
		const loop = (now: number) => {
			const dt = Math.min(now - last, 100);
			last = now;
			const target = dark ? 1 : 0;
			mixRef.current += (target - mixRef.current) * Math.min(1, dt / 260);
			if (Math.abs(target - mixRef.current) < 0.002) mixRef.current = target;
			draw(now);
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [width, height, variant, dark]);

	const canvasCls = "absolute inset-0 h-full w-full";
	return (
		<>
			{/* 底层：光晕/垫体/篮筐后壁 */}
			<div
				className="pointer-events-none absolute left-1/2 z-0 -translate-x-1/2"
				style={{ bottom: 0, width, height }}
				aria-hidden="true"
			>
				<canvas ref={backRef} className={canvasCls} />
			</div>
			{/* 上层：小窝前檐（盖过人物脚边，坐进去的层次）；坐垫造型留空 */}
			<div
				className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
				style={{ bottom: 0, width, height }}
				aria-hidden="true"
			>
				<canvas ref={frontRef} className={canvasCls} />
			</div>
		</>
	);
}

// ---------- 坐垫式台座 ----------

function drawCushion(
	ctx: CanvasRenderingContext2D,
	cx: number,
	w: number,
	h: number,
	p: Palette,
	breath: number,
	phase: number,
	reduced: boolean
) {
	const cy = h * 0.6;
	const rx = w * 0.36;
	const ry = h * 0.26;
	// 地面软影
	ctx.save();
	ctx.beginPath();
	ctx.ellipse(cx, cy + ry * 0.75, rx * 1.16, ry * 0.42, 0, 0, Math.PI * 2);
	ctx.fillStyle = css(p.shadow);
	ctx.fill();
	// 呼吸光晕
	const gr = ctx.createRadialGradient(cx, cy, rx * 0.2, cx, cy, rx * 1.35);
	gr.addColorStop(0, css(p.glowA));
	gr.addColorStop(0.6, css(p.glowB));
	gr.addColorStop(1, "rgba(0,0,0,0)");
	ctx.globalAlpha = breath;
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx * 1.35, ry * 1.6, 0, 0, Math.PI * 2);
	ctx.fillStyle = gr;
	ctx.fill();
	ctx.globalAlpha = 1;
	// 垫面
	const lin = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
	lin.addColorStop(0, css(p.top));
	lin.addColorStop(0.55, css(p.mid));
	lin.addColorStop(1, css(p.bottom));
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	ctx.fillStyle = lin;
	ctx.fill();
	ctx.lineWidth = 1.6;
	ctx.strokeStyle = css(p.rim);
	ctx.stroke();
	// 绣线内圈
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx * 0.78, ry * 0.72, 0, 0, Math.PI * 2);
	ctx.setLineDash([5, 4]);
	ctx.lineWidth = 1.1;
	ctx.strokeStyle = css(p.stitch);
	ctx.stroke();
	ctx.setLineDash([]);
	// 受光高光弧（左上）
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx * 0.97, ry * 0.95, 0, Math.PI * 1.06, Math.PI * 1.42);
	ctx.lineWidth = 2.2;
	ctx.lineCap = "round";
	ctx.strokeStyle = css(p.hl);
	ctx.stroke();
	ctx.restore();
	// 缘边闪星
	twinkle(ctx, cx - rx * 0.86, cy - ry * 0.1, 1.7, phase, 0, reduced, p);
	twinkle(ctx, cx + rx * 0.9, cy, 1.3, phase, 1.1, reduced, p);
	twinkle(ctx, cx + rx * 0.4, cy - ry * 0.85, 1, phase, 2, reduced, p);
}

// ---------- 宠物小窝 ----------

function drawNestBack(
	ctx: CanvasRenderingContext2D,
	cx: number,
	w: number,
	h: number,
	p: Palette,
	breath: number,
	phase: number,
	reduced: boolean
) {
	const cy = h * 0.52;
	const rx = w * 0.4;
	const ry = h * 0.34;
	// 地面软影
	ctx.beginPath();
	ctx.ellipse(cx, cy + ry * 0.8, rx * 1.12, ry * 0.4, 0, 0, Math.PI * 2);
	ctx.fillStyle = css(p.shadow);
	ctx.fill();
	// 呼吸暖光
	const gr = ctx.createRadialGradient(cx, cy, rx * 0.2, cx, cy, rx * 1.4);
	gr.addColorStop(0, css(p.glowA));
	gr.addColorStop(0.6, css(p.glowB));
	gr.addColorStop(1, "rgba(0,0,0,0)");
	ctx.globalAlpha = breath;
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx * 1.4, ry * 1.7, 0, 0, Math.PI * 2);
	ctx.fillStyle = gr;
	ctx.fill();
	ctx.globalAlpha = 1;
	// 篮筐外体
	const lin = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
	lin.addColorStop(0, css(p.top));
	lin.addColorStop(0.55, css(p.mid));
	lin.addColorStop(1, css(p.bottom));
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	ctx.fillStyle = lin;
	ctx.fill();
	ctx.lineWidth = 1.6;
	ctx.strokeStyle = css(p.rim);
	ctx.stroke();
	// 编织纹：沿外圈几道同心弧
	ctx.save();
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	ctx.clip();
	for (let i = 1; i <= 3; i++) {
		ctx.beginPath();
		ctx.ellipse(cx, cy, rx * (1 - i * 0.16), ry * (1 - i * 0.14), 0, 0, Math.PI * 2);
		ctx.setLineDash([7, 6]);
		ctx.lineWidth = 1;
		ctx.strokeStyle = css(p.weave);
		ctx.stroke();
	}
	ctx.setLineDash([]);
	ctx.restore();
	// 窝内软垫
	const rg = ctx.createRadialGradient(cx, cy - ry * 0.1, ry * 0.1, cx, cy, rx * 0.8);
	rg.addColorStop(0, css(p.cushionA));
	rg.addColorStop(1, css(p.cushionB));
	ctx.beginPath();
	ctx.ellipse(cx, cy - ry * 0.05, rx * 0.74, ry * 0.68, 0, 0, Math.PI * 2);
	ctx.fillStyle = rg;
	ctx.fill();
	// 内沿阴影（窝壁压出的暗边）
	ctx.beginPath();
	ctx.ellipse(cx, cy - ry * 0.05, rx * 0.74, ry * 0.68, 0, Math.PI * 1.05, Math.PI * 1.95);
	ctx.lineWidth = 3;
	ctx.strokeStyle = css(p.shadow);
	ctx.stroke();
}

function drawNestFront(
	ctx: CanvasRenderingContext2D,
	cx: number,
	w: number,
	h: number,
	p: Palette
) {
	const cy = h * 0.52;
	const rx = w * 0.4;
	const ry = h * 0.34;
	// 前檐：下半环的厚月牙（外椭圆下半 - 内椭圆下半）
	const rimThick = ry * 0.42;
	ctx.save();
	const grad = ctx.createLinearGradient(0, cy, 0, cy + ry + rimThick * 0.4);
	grad.addColorStop(0, css(p.mid));
	grad.addColorStop(1, css(p.bottom));
	ctx.beginPath();
	// 外弧（左→右经过底部）
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI);
	// 内弧（右→左回，稍微抬高）
	ctx.ellipse(cx, cy - rimThick * 0.3, rx - rimThick * 0.6, ry - rimThick * 0.5, 0, Math.PI, true);
	ctx.closePath();
	ctx.fillStyle = grad;
	ctx.fill();
	ctx.lineWidth = 1.4;
	ctx.strokeStyle = css(p.rim);
	ctx.stroke();
	// 前檐上沿高光
	ctx.beginPath();
	ctx.ellipse(cx, cy - rimThick * 0.3, rx - rimThick * 0.6, ry - rimThick * 0.5, 0, Math.PI * 0.12, Math.PI * 0.88);
	ctx.lineWidth = 2;
	ctx.lineCap = "round";
	ctx.strokeStyle = css(p.hl);
	ctx.stroke();
	// 前檐小肉爪印
	const px = cx;
	const py = cy + ry * 0.62;
	ctx.fillStyle = css(p.paw);
	ctx.beginPath();
	ctx.ellipse(px, py, 4.2, 3.2, 0, 0, Math.PI * 2);
	ctx.fill();
	for (const [dx, dy, r] of [
		[-4.6, -4.4, 1.7],
		[0, -5.6, 1.8],
		[4.6, -4.4, 1.7],
	] as const) {
		ctx.beginPath();
		ctx.arc(px + dx, py + dy, r, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

function twinkle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
	phase: number,
	offset: number,
	reduced: boolean,
	p: Palette
) {
	const a = reduced ? 0.7 : 0.25 + 0.75 * Math.abs(Math.sin(phase * 1.4 + offset));
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fillStyle = css([p.hl[0], p.hl[1], p.hl[2], a]);
	ctx.fill();
}
