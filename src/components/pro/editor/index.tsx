import { Columns2, Copy, Eye, EyeOff } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";

import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { CopyButton, ProButton, type ProButtonSize } from "../base/button";

type EditorViewMode = "edit" | "preview" | "split";

type EditorToolbarContext = {
	value: string;
	disabled: boolean;
	language: string;
	size?: ProButtonSize;
	mode: EditorViewMode;
	hasPreview: boolean;
	isSplitView: boolean;
	setMode: (mode: EditorViewMode) => void;
};

type EditorProps = {
	value?: string;
	onChange?: (value: string) => void;
	disabled?: boolean;
	language?: string;
	className?: string;
	height?: string | number;
	size?: ProButtonSize;
	toolbar?: false | ReactNode | ((context: EditorToolbarContext) => ReactNode);
	toolbarTitle?: ReactNode | ((context: EditorToolbarContext) => ReactNode);
	toolbarMode?: boolean;
	toolbarCopy?: boolean;
	preview?: {
		component: ComponentType<{ content: string; language: string }>;
		mode?: EditorViewMode;
		defaultMode?: EditorViewMode;
		onModeChange?: (mode: EditorViewMode) => void;
	};
};

export function ProEditor({
	value = "",
	onChange,
	disabled = false,
	language = "markdown",
	className,
	height = 420,
	size = "icon-sm",
	toolbar,
	toolbarTitle,
	toolbarMode = true,
	toolbarCopy = true,
	preview,
}: EditorProps) {
	const [uncontrolledMode, setUncontrolledMode] = useState<EditorViewMode>(
		preview?.defaultMode ?? "split",
	);
	const mode = preview?.mode ?? uncontrolledMode;
	const hasPreview = !!preview?.component;
	const Preview = preview?.component;
	const showEditor = !hasPreview || mode !== "preview";
	const showPreview = hasPreview && mode !== "edit";
	const isSplitView = showEditor && showPreview;
	const editorHeight = typeof height === "number" ? `${height}px` : height;

	function setMode(nextMode: EditorViewMode) {
		const next = hasPreview ? nextMode : "edit";
		setUncontrolledMode(next);
		preview?.onModeChange?.(next);
	}

	const context: EditorToolbarContext = {
		value,
		disabled,
		language,
		size,
		mode,
		hasPreview,
		isSplitView,
		setMode,
	};
	const title =
		typeof toolbarTitle === "function"
			? toolbarTitle(context)
			: (toolbarTitle ?? language.toUpperCase());
	const toolbarContent =
		typeof toolbar === "function" ? toolbar(context) : toolbar;

	return (
		<div
			data-slot="pro-editor"
			className={cn(
				"overflow-hidden rounded-md border bg-background",
				className,
			)}
			style={{ height: editorHeight }}
		>
			{toolbar !== false && (
				<div className="flex h-10 items-center gap-1 border-b bg-muted/30 px-2">
					<div className="min-w-0 flex-1 truncate text-sm font-medium">
						{title}
					</div>
					{toolbarContent}
					{hasPreview && toolbarMode && (
						<>
							<ProButton
								variant="ghost"
								size={size}
								tooltip={
									mode === "preview" ? m.common_edit() : m.common_preview()
								}
								onClick={() => setMode(mode === "preview" ? "edit" : "preview")}
							>
								{mode === "preview" ? <EyeOff /> : <Eye />}
							</ProButton>
							<ProButton
								variant="ghost"
								size={size}
								tooltip={m.pro_editor_split()}
								onClick={() => setMode(mode === "split" ? "edit" : "split")}
							>
								<Columns2 />
							</ProButton>
						</>
					)}
					{toolbarCopy && (
						<CopyButton
							variant="ghost"
							size={size}
							tooltip={m.common_copy()}
							copy={value}
							icon={<Copy />}
						/>
					)}
				</div>
			)}
			<div className="flex h-[calc(100%-2.5rem)] min-h-0">
				{showEditor && (
					<textarea
						aria-label={typeof title === "string" ? title : m.common_edit()}
						title={language}
						value={value}
						disabled={disabled}
						onChange={(event) => onChange?.(event.currentTarget.value)}
						spellCheck={false}
						className={cn(
							"h-full resize-none border-0 bg-background p-3 font-mono text-sm outline-none",
							isSplitView ? "w-1/2 border-r" : "w-full",
						)}
					/>
				)}
				{showPreview && Preview && (
					<section
						aria-label={m.common_preview()}
						className={cn(
							"h-full overflow-auto p-4",
							isSplitView ? "w-1/2" : "w-full",
						)}
					>
						<Preview content={value} language={language} />
					</section>
				)}
			</div>
		</div>
	);
}
