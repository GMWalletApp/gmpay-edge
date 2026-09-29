import { CheckIcon } from "lucide-react";
import {
	Checkbox as CheckboxPrimitive,
	Switch as SwitchPrimitive,
} from "radix-ui";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { cn } from "#/lib/utils.ts";

export function Checkbox({
	value,
	defaultValue,
	onChange,
	options,
	disabled,
	children,
	id,
	...props
}: Omit<
	ComponentProps<typeof CheckboxPrimitive.Root>,
	| "value"
	| "defaultValue"
	| "onChange"
	| "checked"
	| "defaultChecked"
	| "onCheckedChange"
> & {
	value?: boolean | string[];
	defaultValue?: boolean | string[];
	onChange?: (checked: boolean | string[]) => void;
	options?: {
		label: ReactNode;
		value: string;
		description?: ReactNode;
		disabled?: boolean;
	}[];
	children?: ReactNode;
}) {
	const generatedId = useId();
	const checkboxId = id ?? generatedId;
	const [internalValues, setInternalValues] = useState<string[]>(
		Array.isArray(defaultValue) ? defaultValue : [],
	);
	const values = Array.isArray(value) ? value : internalValues;

	function commit(next: string[]) {
		if (value === undefined) setInternalValues(next);
		onChange?.(next);
	}

	if (options?.length) {
		const valueSet = new Set(values);

		return (
			<div className="flex flex-col gap-2">
				{options.map((option, index) => {
					const itemId = `${checkboxId}-${index}`;

					return (
						<div key={option.value} className="flex items-start gap-2">
							<CheckboxControl
								id={itemId}
								checked={valueSet.has(option.value)}
								disabled={disabled || option.disabled}
								onCheckedChange={(nextChecked) => {
									if (nextChecked === true) {
										if (!valueSet.has(option.value))
											commit([...values, option.value]);
										return;
									}

									commit(values.filter((item) => item !== option.value));
								}}
								{...props}
							/>
							<label
								htmlFor={itemId}
								className={cn(
									"grid gap-1 text-sm leading-none font-normal select-none",
									disabled || option.disabled
										? "cursor-not-allowed opacity-50"
										: "cursor-pointer",
								)}
							>
								<span>{option.label}</span>
								{option.description != null && (
									<span className="text-xs leading-snug text-muted-foreground">
										{option.description}
									</span>
								)}
							</label>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div className="flex items-start gap-2">
			<CheckboxControl
				id={checkboxId}
				checked={typeof value === "boolean" ? value : undefined}
				defaultChecked={
					typeof defaultValue === "boolean" ? defaultValue : undefined
				}
				onCheckedChange={(checked) => onChange?.(checked === true)}
				disabled={disabled}
				{...props}
			/>
			{children != null && (
				<label
					htmlFor={checkboxId}
					className={cn(
						"flex items-center gap-2 text-sm leading-none font-normal select-none",
						disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
					)}
				>
					{children}
				</label>
			)}
		</div>
	);
}

export function CheckboxControl({
	className,
	...props
}: Omit<
	ComponentProps<typeof CheckboxPrimitive.Root>,
	"checked" | "defaultChecked" | "onChange" | "onCheckedChange" | "value"
> & {
	checked?: boolean | "indeterminate";
	defaultChecked?: boolean | "indeterminate";
	onCheckedChange?: (checked: boolean | "indeterminate") => void;
}) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current transition-none"
			>
				<CheckIcon className="size-3.5" />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export function Switch({
	value,
	onChange,
	className,
	...props
}: Omit<
	ComponentProps<typeof SwitchPrimitive.Root>,
	"checked" | "onCheckedChange" | "onChange" | "value"
> & {
	value?: boolean;
	onChange?: (checked: boolean) => void;
}) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			checked={value}
			onCheckedChange={onChange}
			className={cn(
				"peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className={
					"pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
				}
			/>
		</SwitchPrimitive.Root>
	);
}
