import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

type ConfirmDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: React.ReactNode;
	disabled?: boolean;
	desc: React.JSX.Element | string;
	cancelBtnText?: string;
	confirmText?: React.ReactNode;
	destructive?: boolean;
	isLoading?: boolean;
	className?: string;
	children?: React.ReactNode;
} & (
	| { form: string; handleConfirm?: undefined }
	| { form?: undefined; handleConfirm: () => void }
);

export function ConfirmDialog(props: ConfirmDialogProps) {
	const {
		title,
		desc,
		children,
		className,
		confirmText,
		cancelBtnText,
		destructive,
		isLoading,
		disabled = false,
		form,
		handleConfirm,
		...actions
	} = props;
	return (
		<AlertDialog {...actions}>
			<AlertDialogContent className={cn(className && className)}>
				<AlertDialogHeader className="text-start">
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div>{desc}</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				{children}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isLoading}>
						{cancelBtnText ?? m.common_cancel()}
					</AlertDialogCancel>
					<Button
						type={form ? "submit" : "button"}
						form={form}
						onClick={handleConfirm}
						variant={destructive ? "destructive" : "default"}
						disabled={disabled || isLoading}
					>
						{confirmText ?? m.common_continue()}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
