/**
 * 首次访问欢迎弹窗
 * - 仅首次访问展示：localStorage 存在 wlist-welcomed 即渲染 null（访问包 try/catch）
 * - 关闭方式：点“开始使用”、点背景遮罩、按 Esc；关闭时写入标记
 * - 入场动画 keyframes 前缀 wlistwelcome-，适配深色模式
 */
import { useEffect, useState } from "react";

const WELCOMED_KEY = "wlist-welcomed";

const STYLE = `
@keyframes wlistwelcome-fade {
	from { opacity: 0; }
	to { opacity: 1; }
}
@keyframes wlistwelcome-pop {
	from { opacity: 0; transform: scale(0.9) translateY(10px); }
	to { opacity: 1; transform: scale(1) translateY(0); }
}
.wlistwelcome-fade { animation: wlistwelcome-fade 0.25s ease-out 1 both; }
.wlistwelcome-pop { animation: wlistwelcome-pop 0.35s cubic-bezier(0.34, 1.4, 0.64, 1) 1 both; }
@media (prefers-reduced-motion: reduce) {
	.wlistwelcome-fade,
	.wlistwelcome-pop {
		animation: none !important;
	}
}
`;

/** 是否已欢迎过（localStorage 不可用时按未欢迎处理） */
function hasWelcomed(): boolean {
	try {
		return window.localStorage.getItem(WELCOMED_KEY) !== null;
	} catch {
		return false;
	}
}

/** 三条快速上手提示 */
const TIPS: { emoji: string; text: string }[] = [
	{ emoji: "📤", text: "拖拽文件到页面即可上传" },
	{ emoji: "⚡", text: "下载走直链不限速" },
	{ emoji: "🗂️", text: "支持多网盘聚合与分享" },
];

export default function WelcomeDialog({
	siteTitle,
	announcement,
}: {
	siteTitle: string;
	announcement?: string;
}) {
	const [open, setOpen] = useState<boolean>(() => !hasWelcomed());

	const dismiss = (): void => {
		setOpen(false);
		try {
			window.localStorage.setItem(WELCOMED_KEY, "1");
		} catch {
			// localStorage 不可用就只关弹窗，下次再欢迎一次也无妨
		}
	};

	// Esc 关闭
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") dismiss();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="欢迎">
			<style>{STYLE}</style>

			{/* 背景遮罩 */}
			<div
				className="wlistwelcome-fade absolute inset-0 bg-zinc-950/50 backdrop-blur-sm"
				onClick={dismiss}
				aria-hidden="true"
			/>

			{/* 卡片 */}
			<div className="wlistwelcome-pop relative w-full max-w-md overflow-hidden rounded-3xl border border-zinc-200/80 bg-white shadow-2xl dark:border-zinc-700/60 dark:bg-zinc-900">
				{/* 渐变 hero 带 */}
				<div className="relative h-28 bg-gradient-to-r from-indigo-300 via-violet-300 to-pink-300 dark:from-indigo-500/70 dark:via-violet-500/70 dark:to-pink-500/70">
					<div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
						<div className="grid h-14 w-14 place-items-center rounded-full border-4 border-white bg-white text-3xl shadow-md dark:border-zinc-900 dark:bg-zinc-800">
							✨
						</div>
					</div>
				</div>

				<div className="px-6 pb-6 pt-10">
					<h2 className="text-center text-xl font-bold text-zinc-900 dark:text-zinc-50">
						欢迎来到 {siteTitle}
					</h2>
					<p className="mt-1.5 text-center text-sm text-zinc-500 dark:text-zinc-400">
						你的文件，温柔安放 ✿
					</p>

					{/* 公告 */}
					{announcement !== undefined && announcement !== "" && (
						<blockquote className="mt-4 rounded-xl border-l-4 border-indigo-300 bg-zinc-100 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-600 dark:border-indigo-500/60 dark:bg-zinc-800/60 dark:text-zinc-300">
							{announcement}
						</blockquote>
					)}

					{/* 快速上手 */}
					<ul className="mt-4 space-y-1.5">
						{TIPS.map((tip) => (
							<li
								key={tip.text}
								className="flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
							>
								<span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-lg shadow-sm dark:bg-zinc-800">
									{tip.emoji}
								</span>
								<span className="text-sm text-zinc-700 dark:text-zinc-300">{tip.text}</span>
							</li>
						))}
					</ul>

					<button
						type="button"
						onClick={dismiss}
						className="mt-5 w-full rounded-2xl bg-gradient-to-r from-indigo-500 to-pink-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all duration-200 hover:from-indigo-400 hover:to-pink-400 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-[0.98]"
					>
						开始使用 🎉
					</button>
				</div>
			</div>
		</div>
	);
}
