import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, ChevronUp, Plus, SearchIcon } from "lucide-react";
import {
	Popover as PopoverPrimitive,
	Select as SelectPrimitive,
} from "radix-ui";
import { type ReactNode, useState } from "react";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { ProButton } from "../../button";
import {
	FieldClearAction,
	FieldPopoverContent,
	fieldTriggerClassName,
} from "../shared/field";

export function Select({
	value,
	defaultValue,
	onChange,
	placeholder,
	disabled,
	required,
	options,
	allowClear = false,
	multiple = false,
	searchable,
	allowCreate = false,
	createControl = "action",
	createOptionLabel,
	createInputPlaceholder,
	className,
	ariaLabel,
}: {
	value?: string | string[];
	defaultValue?: string | string[];
	onChange?: (value: string | string[] | undefined) => void;
	placeholder?: string;
	disabled?: boolean;
	required?: boolean;
	options?: {
		label: ReactNode;
		value: string;
		searchText?: string;
		description?: ReactNode;
		disabled?: boolean;
	}[];
	allowClear?: boolean;
	multiple?: boolean;
	searchable?: boolean;
	allowCreate?: boolean;
	createControl?: "action" | "input";
	createOptionLabel?: (value: string) => ReactNode;
	createInputPlaceholder?: string;
	className?: string;
	ariaLabel?: string;
}) {
	const [internalValue, setInternalValue] = useState<
		string | string[] | undefined
	>(defaultValue);
	const [open, setOpen] = useState(false);
	const [searchValue, setSearchValue] = useState("");
	const currentValue = value ?? internalValue;
	const selectedValues = getSelectedValues(currentValue);
	const selectedValueSet = new Set(selectedValues);
	const normalizedSearchValue = searchValue.trim();
	const selectPlaceholder = placeholder ?? m.pro_field_selectPlaceholder();
	const canCreateOption =
		allowCreate &&
		normalizedSearchValue.length > 0 &&
		!(options ?? []).some(
			(option) =>
				option.value.toLowerCase() === normalizedSearchValue.toLowerCase(),
		);
	const createActionLabel =
		normalizedSearchValue.length > 0
			? (createOptionLabel?.(normalizedSearchValue) ?? normalizedSearchValue)
			: (createOptionLabel?.("") ?? selectPlaceholder);
	const selectedOptions =
		options?.filter((option) => selectedValueSet.has(option.value)) ?? [];
	const selectedCount = selectedOptions.length;
	const visibleOptions = filterSelectOptions(
		options ?? [],
		normalizedSearchValue,
	);
	const showClear =
		allowClear && selectedValues.length > 0 && !disabled && !required;
	const showSearchInput = shouldSearchSelectOptions(
		options?.length ?? 0,
		searchable,
	);

	function handleChange(nextValue: string | string[] | undefined) {
		if (value === undefined) setInternalValue(nextValue);
		onChange?.(nextValue);
	}

	function handleCommandSelect(optionValue: string) {
		const normalizedOptionValue = optionValue.trim();
		if (!normalizedOptionValue) return;

		if (!multiple) {
			handleChange(normalizedOptionValue);
			setOpen(false);
			setSearchValue("");
			return;
		}

		const existingValue = selectedValues.find(
			(selectedValue) =>
				selectedValue.toLowerCase() === normalizedOptionValue.toLowerCase(),
		);
		const nextValues = existingValue
			? selectedValues.filter(
					(selectedValue) => selectedValue !== existingValue,
				)
			: [...selectedValues, normalizedOptionValue];
		if (nextValues.length === 0) {
			handleChange(undefined);
			setSearchValue("");
			return;
		}
		handleChange(nextValues);
		setSearchValue("");
	}

	function handleCreateInputConfirm() {
		if (!normalizedSearchValue) return;
		handleCommandSelect(normalizedSearchValue);
	}

	if (multiple || showSearchInput) {
		return (
			<PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
				<PopoverPrimitive.Trigger asChild>
					<button
						type="button"
						role="combobox"
						aria-expanded={open}
						disabled={disabled}
						className={cn(
							fieldTriggerClassName,
							"group/select w-full justify-between font-normal disabled:pointer-events-none disabled:opacity-50",
							selectedCount === 0 &&
								"text-muted-foreground hover:text-muted-foreground",
							className,
						)}
					>
						<span className="flex min-w-0 flex-1 items-center gap-1 truncate text-left">
							{renderSelectedOptions(
								selectedOptions,
								selectedCount,
								selectPlaceholder,
							)}
						</span>
						<span className="relative flex size-4 shrink-0 items-center justify-center">
							{showClear && (
								<FieldClearAction
									label={m.pro_action_clearSelection()}
									onClear={() => handleChange(undefined)}
									className={
										"pointer-events-none absolute inset-0 z-10 opacity-0 group-hover/select:pointer-events-auto group-hover/select:opacity-100 group-focus-within/select:pointer-events-auto group-focus-within/select:opacity-100"
									}
								/>
							)}
							<ChevronDown
								className={cn(
									"size-4 opacity-50",
									showClear &&
										"group-hover/select:opacity-0 group-focus-within/select:opacity-0",
								)}
							/>
						</span>
					</button>
				</PopoverPrimitive.Trigger>
				<FieldPopoverContent
					className="w-[var(--radix-popover-trigger-width)] p-0"
					align="start"
				>
					<CommandPrimitive
						shouldFilter={false}
						className={
							"flex size-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
						}
					>
						{showSearchInput && (
							<div className="flex h-9 items-center gap-2 border-b px-3">
								<SearchIcon className="size-4 shrink-0 opacity-50" />
								<CommandPrimitive.Input
									placeholder={placeholder ?? m.common_search()}
									value={searchValue}
									onValueChange={setSearchValue}
									onKeyDown={(event) => {
										if (event.key === "Enter" && normalizedSearchValue) {
											event.preventDefault();
											handleCommandSelect(normalizedSearchValue);
										}
									}}
									className={
										"flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
									}
								/>
							</div>
						)}
						<CommandPrimitive.List className="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
							{visibleOptions.length > 0 ||
							allowCreate ||
							canCreateOption ? null : (
								<CommandPrimitive.Empty className="py-6 text-center text-sm">
									{m.layout_commandEmpty()}
								</CommandPrimitive.Empty>
							)}
							<CommandPrimitive.Group className="overflow-hidden p-1 text-foreground">
								{visibleOptions.map((option) => (
									<CommandPrimitive.Item
										key={option.value}
										value={[
											option.value,
											option.searchText,
											typeof option.label === "string"
												? option.label
												: undefined,
										]
											.filter(Boolean)
											.join(" ")}
										disabled={option.disabled}
										onSelect={() => handleCommandSelect(option.value)}
										className={
											"relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"
										}
									>
										<Check
											className={cn(
												"size-4",
												selectedValueSet.has(option.value)
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<span className="grid gap-1">
											<span>{option.label}</span>
											{option.description != null && (
												<span className="text-xs leading-snug text-muted-foreground">
													{option.description}
												</span>
											)}
										</span>
									</CommandPrimitive.Item>
								))}
							</CommandPrimitive.Group>
						</CommandPrimitive.List>
						{allowCreate && createControl === "input" ? (
							<div className="flex h-10 items-center gap-2 border-t px-3">
								<Plus className="size-4 shrink-0 opacity-60" />
								<input
									type="text"
									value={searchValue}
									placeholder={createInputPlaceholder ?? selectPlaceholder}
									onChange={(event) => setSearchValue(event.target.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											canCreateOption &&
											normalizedSearchValue
										) {
											event.preventDefault();
											handleCreateInputConfirm();
										}
									}}
									className={
										"flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
									}
								/>
								<ProButton
									type="button"
									size="xs"
									disabled={!canCreateOption}
									onMouseDown={(event) => event.preventDefault()}
									onClick={handleCreateInputConfirm}
									className="h-7 shrink-0 px-2"
								>
									{m.common_confirm()}
								</ProButton>
							</div>
						) : allowCreate ? (
							<div className="border-t p-1">
								<button
									type="button"
									disabled={!canCreateOption}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										if (canCreateOption) {
											handleCommandSelect(normalizedSearchValue);
										}
									}}
									className={cn(
										"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors focus-visible:bg-accent focus-visible:text-accent-foreground",
										canCreateOption
											? "hover:bg-accent hover:text-accent-foreground"
											: "cursor-not-allowed text-muted-foreground opacity-60",
									)}
								>
									<Check className="size-4 opacity-0" />
									<span className="min-w-0 truncate">{createActionLabel}</span>
								</button>
							</div>
						) : null}
					</CommandPrimitive>
				</FieldPopoverContent>
			</PopoverPrimitive.Root>
		);
	}

	return (
		<SelectPrimitive.Root
			data-slot="field-select"
			value={selectedValues[0]}
			onValueChange={handleChange}
			disabled={disabled}
			required={required}
		>
			<SelectPrimitive.Trigger
				aria-label={ariaLabel}
				data-slot="field-select-trigger"
				disabled={disabled}
				className={cn(
					fieldTriggerClassName,
					"group/select w-full justify-between font-normal disabled:pointer-events-none disabled:opacity-50",
					selectedValues.length === 0 && "text-muted-foreground",
					className,
				)}
			>
				<span className="flex min-w-0 flex-1 items-center gap-2 text-left">
					<SelectPrimitive.Value
						data-slot="field-select-value"
						placeholder={selectPlaceholder}
					>
						{selectedValues.length > 0 ? (
							<span className="line-clamp-1 flex min-w-0 flex-1 items-center gap-2 text-left">
								{selectedOptions[0]?.label}
							</span>
						) : undefined}
					</SelectPrimitive.Value>
				</span>
				<span className="relative flex size-4 shrink-0 items-center justify-center">
					{showClear && (
						<FieldClearAction
							label={m.pro_action_clearSelection()}
							onClear={() => handleChange(undefined)}
							className={
								"pointer-events-none absolute inset-0 z-10 opacity-0 group-hover/select:pointer-events-auto group-hover/select:opacity-100 group-focus-within/select:pointer-events-auto group-focus-within/select:opacity-100"
							}
						/>
					)}
					<ChevronDown
						className={cn(
							"size-4 opacity-50",
							showClear &&
								"group-hover/select:opacity-0 group-focus-within/select:opacity-0",
						)}
					/>
				</span>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					data-slot="field-select-content"
					position="item-aligned"
					className={
						"relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
					}
				>
					<SelectPrimitive.ScrollUpButton
						data-slot="field-select-scroll-up-button"
						className="flex cursor-default items-center justify-center py-1"
					>
						<ChevronUp className="size-4" />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport className="p-1">
						{options?.map((option) => (
							<SelectPrimitive.Item
								key={option.value}
								value={option.value}
								disabled={option.disabled}
								data-slot="field-select-item"
								className={
									"relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2"
								}
							>
								<span
									data-slot="field-select-item-indicator"
									className="absolute right-2 flex size-3.5 items-center justify-center"
								>
									<SelectPrimitive.ItemIndicator>
										<Check className="size-4" />
									</SelectPrimitive.ItemIndicator>
								</span>
								<SelectPrimitive.ItemText>
									<span className="grid gap-1">
										<span>{option.label}</span>
										{option.description != null && (
											<span className="text-xs leading-snug text-muted-foreground">
												{option.description}
											</span>
										)}
									</span>
								</SelectPrimitive.ItemText>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton
						data-slot="field-select-scroll-down-button"
						className="flex cursor-default items-center justify-center py-1"
					>
						<ChevronDown className="size-4" />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}

export function shouldSearchSelectOptions(
	optionCount: number,
	searchable?: boolean,
) {
	return searchable ?? optionCount > 10;
}

type SearchableSelectOption = {
	label: ReactNode;
	value: string;
	searchText?: string;
	description?: ReactNode;
	disabled?: boolean;
};

export function filterSelectOptions(
	options: readonly SearchableSelectOption[],
	searchValue: string,
) {
	const query = searchValue.trim().toLocaleLowerCase();
	if (!query) return options;
	return options.filter((option) =>
		[
			option.value,
			option.searchText,
			typeof option.label === "string" ? option.label : undefined,
		]
			.filter(Boolean)
			.join(" ")
			.toLocaleLowerCase()
			.includes(query),
	);
}

function getSelectedValues(value: string | string[] | undefined) {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return [value];
	return [];
}

function renderSelectedOptions(
	selectedOptions: Array<{ label: ReactNode; value: string }>,
	selectedCount: number,
	placeholder: ReactNode,
) {
	if (selectedCount === 1) {
		return <span className="truncate">{selectedOptions[0]?.label}</span>;
	}

	if (selectedCount <= 1) return placeholder;

	return (
		<>
			{selectedOptions.slice(0, 2).map((option) => (
				<span
					key={option.value}
					className={
						"inline-flex max-w-24 shrink-0 items-center justify-center truncate rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground"
					}
				>
					{option.label}
				</span>
			))}
			{selectedCount > 2 && (
				<span
					className={
						"inline-flex shrink-0 items-center justify-center rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground"
					}
				>
					+{selectedCount - 2}
				</span>
			)}
		</>
	);
}
