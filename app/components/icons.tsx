import { getFileType } from "~/lib/file-utils";

type IconProps = { className?: string };

function svgProps(className?: string) {
	return {
		className: className ?? "h-4 w-4",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.8,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
}

// ---------- 文件类型图标 ----------

export const FolderIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-blue-500"}>
		<path
			d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
			fill="currentColor"
			fillOpacity={0.15}
		/>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
	</svg>
);

export const ImageIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-emerald-500"}>
		<rect x="3" y="4" width="18" height="16" rx="2" fill="currentColor" fillOpacity={0.15} />
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<circle cx="9" cy="10" r="1.6" />
		<path d="m4 18 5-5 3 3 3-3 5 5" />
	</svg>
);

export const VideoIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-purple-500"}>
		<rect x="3" y="5" width="13" height="14" rx="2" fill="currentColor" fillOpacity={0.15} />
		<rect x="3" y="5" width="13" height="14" rx="2" />
		<path d="m16 10 5-3v10l-5-3" />
	</svg>
);

export const AudioIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-pink-500"}>
		<path d="M9 18V6l10-2v12" fill="currentColor" fillOpacity={0.15} />
		<path d="M9 18V6l10-2v12" />
		<circle cx="6.5" cy="18" r="2.5" />
		<circle cx="16.5" cy="16" r="2.5" />
	</svg>
);

export const CodeIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-sky-500"}>
		<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />
	</svg>
);

export const TextIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-zinc-500"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4M8 12h8M8 16h6" />
	</svg>
);

export const PdfIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-red-500"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4" />
		<path d="M8 13h1.5a1 1 0 0 1 0 2H8v-2zm0 2v2" />
		<path d="M12.5 13v4" />
		<path d="M15.5 13h1a1.5 1.5 0 0 1 0 3h-1v-3zm0 3v1" />
	</svg>
);

export const DocIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-blue-600"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4M8 12h8M8 16h8" />
	</svg>
);

export const SheetIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-green-600"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4" />
		<path d="M8 12v5h8v-5H8zm3 0v5m3-5v5M8 14.5h8" />
	</svg>
);

export const SlideIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-orange-500"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4" />
		<rect x="8" y="12" width="8" height="5" rx="1" />
	</svg>
);

export const ArchiveIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-amber-600"}>
		<path d="M5 4h14v16H5z" fill="currentColor" fillOpacity={0.15} />
		<path d="M5 4h14v16H5z" />
		<path d="M12 4v4m0 2v2" />
		<rect x="10.5" y="10" width="3" height="3" rx="0.5" />
	</svg>
);

export const FileIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)} className={className ?? "h-4 w-4 text-zinc-400"}>
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity={0.15} />
		<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
		<path d="M14 3v4h4" />
	</svg>
);

/** 按文件名返回对应类型图标 */
export function FileTypeIcon({
	name,
	isDirectory,
	className,
}: {
	name: string;
	isDirectory?: boolean;
	className?: string;
}) {
	if (isDirectory) return <FolderIcon className={className} />;
	const type = getFileType(name);
	switch (type) {
		case "image":
			return <ImageIcon className={className} />;
		case "video":
			return <VideoIcon className={className} />;
		case "audio":
			return <AudioIcon className={className} />;
		case "code":
		case "markdown":
			return <CodeIcon className={className} />;
		case "pdf":
			return <PdfIcon className={className} />;
		case "docx":
			return <DocIcon className={className} />;
		case "xlsx":
			return <SheetIcon className={className} />;
		case "pptx":
			return <SlideIcon className={className} />;
		case "archive":
			return <ArchiveIcon className={className} />;
		case "text":
			return <TextIcon className={className} />;
		default:
			return <FileIcon className={className} />;
	}
}

// ---------- 存储类型图标（品牌近似图形） ----------

export const StorageIcon = ({
	type,
	className,
}: {
	type: string;
	className?: string;
}) => {
	const cls = className ?? "h-4 w-4";
	switch (type) {
		case "webdav":
		case "webdev":
			return (
				<svg className={`${cls} text-sky-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
					<circle cx="12" cy="5" r="2.5" />
					<circle cx="5" cy="19" r="2.5" />
					<circle cx="19" cy="19" r="2.5" />
					<path d="M12 7.5V12m0 0-5.5 4.8M12 12l5.5 4.8" strokeLinecap="round" />
				</svg>
			);
		case "onedrive":
			return (
				<svg className={`${cls} text-sky-600`} viewBox="0 0 24 24" fill="currentColor">
					<path d="M9.9 5.5a5.4 5.4 0 0 1 5.1 3.6 4.3 4.3 0 0 1 1.2-.2 4.3 4.3 0 0 1 4.2 4.3 4.3 4.3 0 0 1-4.3 4.3H7.2A5.2 5.2 0 0 1 2 12.3a5.2 5.2 0 0 1 4-5 5.4 5.4 0 0 1 3.9-1.8z" fillOpacity={0.85} />
				</svg>
			);
		case "gdrive":
			return (
				<svg className={`${cls} text-amber-500`} viewBox="0 0 24 24" fill="currentColor">
					<path d="M8.4 3h7.2l6.4 11h-7.2L8.4 3z" fillOpacity={0.9} />
					<path d="M8.4 3 2 14l3.6 6.2L12 9.2 8.4 3z" fillOpacity={0.6} />
					<path d="m12.1 14 3.6 6.2h7.2l-3.6-6.2h-7.2z" fillOpacity={0.75} />
				</svg>
			);
		case "baiduyun":
			return (
				<svg className={`${cls} text-blue-500`} viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 2a6 6 0 0 0-3.5 10.9A4 4 0 0 0 6 22h12a4 4 0 0 0-2.5-9.1A6 6 0 0 0 12 2z" fillOpacity={0.85} />
				</svg>
			);
		case "alicloud":
			return (
				<svg className={`${cls} text-indigo-500`} viewBox="0 0 24 24" fill="currentColor">
					<path d="M7 4h10a5 5 0 0 1 4.3 7.6A5.5 5.5 0 0 1 15.8 20H8a6 6 0 0 1-1.6-11.8A5 5 0 0 1 7 4z" fillOpacity={0.85} />
				</svg>
			);
		default:
			// s3 / 对象存储
			return (
				<svg className={`${cls} text-orange-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
					<path d="M4 7.5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
					<path d="M4 7.5v9c0 1.7 3.6 3 8 3s8-1.3 8-3v-9" />
					<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
				</svg>
			);
	}
};

// ---------- UI 图标 ----------

export const SearchIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</svg>
);

export const UploadIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M12 16V4m0 0 4 4m-4-4L8 8" />
		<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
	</svg>
);

export const DownloadIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M12 4v12m0 0 4-4m-4 4-4-4" />
		<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
	</svg>
);

export const RefreshIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M20 11a8 8 0 1 0-2.5 5.8" />
		<path d="M20 5v6h-6" />
	</svg>
);

export const SunIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</svg>
);

export const MoonIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
	</svg>
);

export const LoginIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
		<path d="M10 17l5-5-5-5m5 5H3" />
	</svg>
);

export const LogoutIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<path d="m16 17 5-5-5-5m5 5H9" />
	</svg>
);

export const ShieldIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-3z" />
		<path d="m9 12 2 2 4-4" />
	</svg>
);

export const CloseIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M6 6l12 12M18 6 6 18" />
	</svg>
);

export const MoreIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
		<circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
	</svg>
);

export const ShareIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<circle cx="6" cy="12" r="2.5" />
		<circle cx="18" cy="6" r="2.5" />
		<circle cx="18" cy="18" r="2.5" />
		<path d="m8.3 10.8 7.4-3.6m-7.4 6 7.4 3.6" />
	</svg>
);

export const RenameIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
	</svg>
);

export const MoveIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M5 12h14m0 0-4-4m4 4-4 4" />
		<path d="M12 5V3m0 18v-2" strokeDasharray="0" />
	</svg>
);

export const TrashIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M4 7h16M10 11v6m4-6v6" />
		<path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
		<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
	</svg>
);

export const FolderPlusIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
		<path d="M12 11v5m-2.5-2.5h5" />
	</svg>
);

export const LinkIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
		<path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
	</svg>
);

export const StatsIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
	</svg>
);

export const ChevronRightIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="m9 6 6 6-6 6" />
	</svg>
);

export const HomeIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="m3 11 9-8 9 8" />
		<path d="M5 10v10h5v-6h4v6h5V10" />
	</svg>
);

export const EyeIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
		<circle cx="12" cy="12" r="3" />
	</svg>
);

export const CopyIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<rect x="9" y="9" width="12" height="12" rx="2" />
		<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
	</svg>
);

export const CheckIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="m5 13 4 4L19 7" />
	</svg>
);

export const SpinnerIcon = ({ className }: IconProps) => (
	<svg
		className={className ?? "h-4 w-4 animate-spin"}
		viewBox="0 0 24 24"
		fill="none"
	>
		<circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity={0.25} strokeWidth={3} />
		<path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
	</svg>
);

export const CloudIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M7 18a5 5 0 1 1 .9-9.9A6.5 6.5 0 0 1 20 10a4 4 0 0 1-1 8H7z" />
	</svg>
);

export const HistoryIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<path d="M3 12a9 9 0 1 0 3-6.7" />
		<path d="M3 4v5h5" />
		<path d="M12 8v4l3 3" />
	</svg>
);

export const GlobeIcon = ({ className }: IconProps) => (
	<svg {...svgProps(className)}>
		<circle cx="12" cy="12" r="9" />
		<path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
	</svg>
);
