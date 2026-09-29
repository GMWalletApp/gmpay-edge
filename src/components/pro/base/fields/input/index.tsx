import { Eye, EyeOff } from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import {
	type ChangeEvent,
	type ChangeEventHandler,
	type ComponentProps,
	type ReactNode,
	type Ref,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { ProButton } from "../../button";
import { FieldClearButton, fieldShellClassName } from "../shared/field";

interface InputProps
	extends Omit<
		ComponentProps<"input">,
		| "children"
		| "className"
		| "defaultValue"
		| "onChange"
		| "prefix"
		| "ref"
		| "value"
	> {
	value?: string | number | readonly string[];
	defaultValue?: string | number | readonly string[];
	onChange?: ChangeEventHandler<HTMLInputElement>;
	className?: string;
	inputClassName?: string;
	prefix?: ReactNode;
	suffix?: ReactNode;
	allowClear?: boolean;
	onClear?: () => void;
	ref?: Ref<HTMLInputElement>;
}

export function Input({
	prefix,
	suffix,
	allowClear = true,
	onClear,
	className,
	inputClassName,
	type,
	value,
	defaultValue,
	onChange,
	disabled,
	readOnly,
	ref,
	...props
}: InputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	function setInputRef(node: HTMLInputElement | null) {
		inputRef.current = node;
		if (typeof ref === "function") {
			ref(node);
			return;
		}
		if (ref) ref.current = node;
	}

	const [internalValue, setInternalValue] = useState(defaultValue ?? "");
	const currentValue = value ?? internalValue;
	const showClear =
		!!allowClear &&
		currentValue !== "" &&
		currentValue != null &&
		!disabled &&
		!readOnly;
	const hasPrefix = prefix != null && prefix !== false;
	const hasSuffix = (suffix != null && suffix !== false) || showClear;
	const renderedSuffix =
		typeof suffix === "string" || typeof suffix === "number" ? (
			<span
				data-slot="input-suffix"
				className="flex shrink-0 select-none items-center px-3 text-muted-foreground text-sm whitespace-nowrap"
			>
				{suffix}
			</span>
		) : (
			suffix
		);

	function emitValue(nextValue: string, event?: ChangeEvent<HTMLInputElement>) {
		if (value === undefined) setInternalValue(nextValue);
		const inputEl = inputRef.current;
		if (!inputEl) return;

		inputEl.value = nextValue;
		onChange?.({
			...event,
			target: inputEl,
			currentTarget: inputEl,
		} as ChangeEvent<HTMLInputElement>);
	}

	function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
		if (value === undefined) setInternalValue(event.target.value);
		onChange?.(event);
	}

	return (
		<div
			className={cn(
				fieldShellClassName,
				hasPrefix && "pl-0",
				hasSuffix && "pr-0",
				disabled && "pointer-events-none opacity-50",
				className,
			)}
		>
			{hasPrefix && <div className="flex shrink-0 items-center">{prefix}</div>}

			<input
				ref={setInputRef}
				type={type}
				data-slot="input"
				value={String(currentValue ?? "")}
				onChange={handleInputChange}
				disabled={disabled}
				readOnly={readOnly}
				className={cn(
					"h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base shadow-none outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed md:text-sm dark:bg-transparent",
					inputClassName,
				)}
				{...props}
			/>

			{hasSuffix && (
				<div className="flex shrink-0 items-center">
					{showClear && (
						<FieldClearButton
							label={m.pro_field_clearInput()}
							className="ml-0"
							onClear={() => {
								onClear?.();
								emitValue("");
							}}
						/>
					)}
					{renderedSuffix}
				</div>
			)}
		</div>
	);
}

export function Password({
	className,
	suffix,
	inputClassName,
	onVisibilityChange,
	ref,
	...props
}: Omit<InputProps, "type"> & {
	onVisibilityChange?: (visible: boolean) => void;
}) {
	const [visible, setVisible] = useState(false);

	return (
		<Input
			ref={ref}
			{...props}
			type={visible ? "text" : "password"}
			className={className}
			inputClassName={inputClassName}
			suffix={
				<>
					{suffix}
					<ProButton
						variant="ghost"
						size="icon-sm"
						onClick={() =>
							setVisible((value) => {
								onVisibilityChange?.(!value);
								return !value;
							})
						}
						aria-label={
							visible ? m.pro_field_hidePassword() : m.pro_field_showPassword()
						}
					>
						{visible ? <EyeOff /> : <Eye />}
					</ProButton>
				</>
			}
		/>
	);
}

interface TextareaProps extends Omit<ComponentProps<"textarea">, "ref"> {
	onClear?: () => void;
	ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({
	onClear,
	className,
	value,
	defaultValue,
	onChange,
	disabled,
	readOnly,
	ref,
	...props
}: TextareaProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	function setTextareaRef(node: HTMLTextAreaElement | null) {
		textareaRef.current = node;
		if (typeof ref === "function") {
			ref(node);
			return;
		}
		if (ref) ref.current = node;
	}
	const [internalValue, setInternalValue] = useState(defaultValue ?? "");
	const currentValue = value ?? internalValue;
	const showClear =
		currentValue !== "" && currentValue != null && !disabled && !readOnly;

	return (
		<div className="relative w-full">
			<textarea
				ref={setTextareaRef}
				data-slot="textarea"
				value={currentValue}
				onChange={(event) => {
					if (value === undefined) setInternalValue(event.target.value);
					onChange?.(event);
				}}
				disabled={disabled}
				readOnly={readOnly}
				className={cn(
					"flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
					showClear && "pr-8",
					className,
				)}
				{...props}
			/>
			{showClear && (
				<FieldClearButton
					label={m.pro_field_clearTextarea()}
					onClear={() => {
						if (value === undefined) setInternalValue("");
						onClear?.();

						const field = textareaRef.current;
						if (!field) return;

						field.value = "";
						onChange?.({
							target: field,
							currentTarget: field,
						} as ChangeEvent<HTMLTextAreaElement>);
					}}
					className="absolute top-2 right-2 z-10 ml-0"
				/>
			)}
		</div>
	);
}

export function Slider({
	value,
	defaultValue,
	onChange,
	min = 0,
	max = 100,
	step = 1,
	disabled,
	className,
	...props
}: Omit<
	ComponentProps<typeof SliderPrimitive.Root>,
	| "value"
	| "defaultValue"
	| "onValueChange"
	| "min"
	| "max"
	| "step"
	| "disabled"
	| "className"
> & {
	value?: number;
	defaultValue?: number;
	onChange?: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<SliderPrimitive.Root
			data-slot="slider"
			value={value === undefined ? undefined : [value]}
			defaultValue={value === undefined ? [defaultValue ?? min] : undefined}
			onValueChange={(nextValue) => onChange?.(nextValue[0] ?? min)}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			className={cn(
				"relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track
				data-slot="slider-track"
				className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
			>
				<SliderPrimitive.Range
					data-slot="slider-range"
					className="absolute h-full bg-primary"
				/>
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				className={
					"block size-4 shrink-0 rounded-full border border-primary bg-primary shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
				}
			/>
		</SliderPrimitive.Root>
	);
}
