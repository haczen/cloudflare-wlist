/**
 * 站点吉祥物（右下角浮动小猫）
 * - 纯内联 SVG 的圆滚滚粉色小猫：耳朵、眯眯眼（周期性眨眼）、腮红、摇摆尾巴
 * - 所有动画走 <style> 内 keyframes，类名前缀 sitepet-，尊重 prefers-reduced-motion
 * - 点击：跳跃一下 + 头顶气泡说一句随机文案（busy 时偏好“上传中”主题）
 */
import { useEffect, useRef, useState } from "react";

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
@media (prefers-reduced-motion: reduce) {
	.sitepet-bob,
	.sitepet-blink,
	.sitepet-wag,
	.sitepet-twitch,
	.sitepet-hop,
	.sitepet-bubble-in {
		animation: none !important;
	}
}
`;

export default function SitePet({ busy }: { busy?: boolean }) {
	const [phrase, setPhrase] = useState<string | null>(null);
	const [hopKey, setHopKey] = useState(0);
	const timerRef = useRef<number | undefined>(undefined);
	const lastIdxRef = useRef(-1);

	// 卸载时清掉气泡定时器
	useEffect(() => {
		return () => window.clearTimeout(timerRef.current);
	}, []);

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

	return (
		<div className="fixed right-4 bottom-[88px] z-40 select-none">
			<style>{STYLE}</style>

			{/* 头顶气泡 */}
			{phrase !== null && (
				<div
					key={hopKey}
					className="sitepet-bubble-in absolute bottom-full left-1/2 mb-2 w-max max-w-[13rem]"
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
				title="戳我一下"
				aria-label="戳我一下"
				onClick={poke}
				className="block cursor-pointer rounded-full opacity-90 transition-all duration-200 hover:scale-105 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-95"
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
			</button>
		</div>
	);
}
