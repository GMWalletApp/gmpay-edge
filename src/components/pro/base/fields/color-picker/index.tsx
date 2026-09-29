import { Popover as PopoverPrimitive } from "radix-ui";
import { RgbaStringColorPicker } from "react-colorful";
import { Button } from "#/components/ui/button";
import { Input } from "../input";
import { FieldPopoverContent } from "../shared/field";
import { normalizeRgba } from "./utils";

export function ColorPicker({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
}) {
	const normalized = normalizeRgba(value);
	const rgba = normalized.startsWith("rgba(")
		? normalized
		: "rgba(255, 255, 255, 1)";
	return (
		<Input
			value={value}
			aria-label={label}
			placeholder="rgba(255, 255, 255, 1)"
			onChange={(event) => onChange(event.target.value)}
			onBlur={() => onChange(normalized)}
			prefix={
				<div className="flex items-center pr-3">
					<PopoverPrimitive.Root>
						<PopoverPrimitive.Trigger asChild>
							<Button
								type="button"
								variant="ghost"
								className="size-8 overflow-hidden bg-[conic-gradient(#e5e7eb_25%,#fff_0_50%,#e5e7eb_0_75%,#fff_0)] bg-size-[10px_10px] p-0"
								aria-label={label}
							>
								<span className="size-full" style={{ background: rgba }} />
							</Button>
						</PopoverPrimitive.Trigger>
						<FieldPopoverContent className="w-auto p-3" align="start">
							<RgbaStringColorPicker color={rgba} onChange={onChange} />
						</FieldPopoverContent>
					</PopoverPrimitive.Root>
				</div>
			}
		/>
	);
}
