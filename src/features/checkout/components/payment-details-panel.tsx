import {
	ArrowLeftRight,
	Check,
	ExternalLink,
	LoaderCircle,
	Send,
	Timer,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Input } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { m } from "#/paraglide/messages";
import {
	type CheckoutOrder,
	type PaymentFlowKind,
	safeHostedPaymentUrl,
} from "../checkout-model";
import { CopyIconButton, formatRemaining } from "./checkout-display";
import { PaymentReviewDialog } from "./payment-review-dialog";

const TIMER_CIRCUMFERENCE = 2 * Math.PI * 20;

export function PaymentDetailsPanel({
	onCopyAddress,
	onChangePaymentOption,
	onSubmitTxHash,
	onTxHashChange,
	order,
	paymentFlow,
	remaining,
	showChangePaymentOption,
	showTxHashSubmit,
	showReviewSubmit,
	submittingTxHash,
	timeColor,
	timerRatio,
	txHash,
	orderId,
	onReviewSubmitted,
}: {
	onCopyAddress: () => boolean | undefined | Promise<boolean | undefined>;
	onChangePaymentOption: () => void;
	onSubmitTxHash: () => Promise<boolean>;
	onTxHashChange: (value: string) => void;
	order?: CheckoutOrder;
	paymentFlow?: PaymentFlowKind;
	remaining: number;
	showChangePaymentOption: boolean;
	showTxHashSubmit: boolean;
	showReviewSubmit: boolean;
	submittingTxHash: boolean;
	timeColor: string;
	timerRatio: number;
	txHash: string;
	orderId: string;
	onReviewSubmitted: () => void;
}) {
	const [txHashDialogOpen, setTxHashDialogOpen] = useState(false);
	const qrValue = order?.receive_address ?? "";
	const paymentUrl = safeHostedPaymentUrl(order?.payment_url);
	const isOkpayPayment =
		paymentFlow === "okpay" || String(order?.network ?? "") === "okpay";

	if (isOkpayPayment || (paymentUrl && !qrValue)) {
		return (
			<section className="w-full pb-4">
				<div className="mb-4 w-full rounded-2xl border bg-card px-5 py-5 text-card-foreground shadow-md">
					<p className="mb-2 font-semibold text-sm">
						{m.checkout_redirecting_okpay()}
					</p>
					{paymentUrl ? (
						<p className="break-all text-muted-foreground text-sm">
							{paymentUrl}
						</p>
					) : null}
				</div>
				{paymentUrl ? (
					<Button
						className="mb-3 h-12 w-full rounded-xl text-base"
						onClick={() => {
							window.open(
								paymentUrl,
								"okpay_checkout",
								"popup,width=480,height=720",
							);
						}}
						type="button"
					>
						<ExternalLink />
						{m.checkout_open_okpay()}
					</Button>
				) : null}
			</section>
		);
	}

	return (
		<section className="w-full pb-4">
			<div className="mb-4 w-full overflow-hidden rounded-2xl border bg-card px-5 pt-5 pb-0 text-card-foreground shadow-md">
				<div className="mb-3 flex items-center justify-between">
					<p className="font-semibold text-sm">{m.checkout_scan()}</p>
					<div className="relative size-10 shrink-0">
						<svg
							aria-hidden="true"
							className="absolute inset-0 size-10"
							viewBox="0 0 48 48"
						>
							<circle
								className="text-border"
								cx="24"
								cy="24"
								fill="none"
								r="20"
								stroke="currentColor"
								strokeWidth="3"
							/>
							<circle
								cx="24"
								cy="24"
								fill="none"
								r="20"
								stroke={timeColor}
								strokeDasharray={TIMER_CIRCUMFERENCE}
								strokeDashoffset={TIMER_CIRCUMFERENCE * (1 - timerRatio)}
								strokeLinecap="round"
								strokeWidth="3"
								style={{
									transform: "rotate(-90deg)",
									transformOrigin: "50% 50%",
								}}
							/>
						</svg>
						<div className="absolute inset-0 flex items-center justify-center">
							<Timer className="size-4 text-muted-foreground" />
						</div>
					</div>
				</div>
				<p
					className="mb-4 text-center font-bold font-mono text-3xl leading-none"
					style={{ color: timeColor }}
				>
					{formatRemaining(remaining)}
				</p>
				<div className="mb-4 flex justify-center">
					<div className="rounded-xl border bg-white p-3.5 shadow-md">
						{qrValue ? (
							<QRCodeSVG
								bgColor="#ffffff"
								fgColor="#111111"
								level="M"
								size={120}
								title={m.checkout_qr_title()}
								value={qrValue}
							/>
						) : (
							<div className="flex size-30 items-center justify-center text-muted-foreground text-xs">
								--
							</div>
						)}
					</div>
				</div>
				<div className="-mx-5 flex w-[calc(100%+2.5rem)] items-start gap-3 border-border/50 border-t px-5 py-3.5">
					<div className="min-w-0 flex-1">
						<p className="mb-0.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
							{m.checkout_payment_address()}
						</p>
						<p className="break-all font-medium text-card-foreground text-sm leading-relaxed">
							{order?.receive_address ?? "--"}
						</p>
					</div>
					<CopyIconButton className="mt-0.5" onClick={onCopyAddress} />
				</div>
			</div>
			{showChangePaymentOption ? (
				<Button
					className="mb-3 h-12 w-full rounded-xl text-base"
					onClick={onChangePaymentOption}
					type="button"
					variant="outline"
				>
					<ArrowLeftRight />
					{m.checkout_change_payment_asset()}
				</Button>
			) : null}
			{showTxHashSubmit ? (
				<Dialog onOpenChange={setTxHashDialogOpen} open={txHashDialogOpen}>
					<DialogTrigger asChild>
						<Button
							className="mb-3 h-12 w-full rounded-xl text-base"
							type="button"
						>
							<Check />
							{m.checkout_transferred()}
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{m.checkout_tx_hash_title()}</DialogTitle>
							<DialogDescription>{m.checkout_tx_hash_desc()}</DialogDescription>
						</DialogHeader>
						<form
							className="space-y-4"
							onSubmit={async (event) => {
								event.preventDefault();
								const submitted = await onSubmitTxHash();
								if (submitted) {
									setTxHashDialogOpen(false);
								}
							}}
						>
							<div className="space-y-2">
								<label
									className="font-medium text-sm"
									htmlFor="checkout-tx-hash"
								>
									{m.checkout_tx_hash_label()}
								</label>
								<Input
									autoComplete="off"
									autoFocus
									className="h-11"
									disabled={submittingTxHash}
									id="checkout-tx-hash"
									onChange={(event) => onTxHashChange(event.target.value)}
									placeholder={m.checkout_tx_hash_placeholder()}
									value={txHash}
								/>
							</div>
							<p className="text-muted-foreground text-xs leading-relaxed">
								{m.checkout_tx_hash_hint()}
							</p>
							<DialogFooter>
								<DialogClose asChild>
									<Button
										disabled={submittingTxHash}
										type="button"
										variant="outline"
									>
										{m.common_cancel()}
									</Button>
								</DialogClose>
								<Button
									disabled={submittingTxHash || !txHash.trim()}
									type="submit"
								>
									{submittingTxHash ? (
										<LoaderCircle className="animate-spin" />
									) : (
										<Send />
									)}
									{m.checkout_tx_hash_submit()}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			) : null}
			{showReviewSubmit ? (
				<PaymentReviewDialog
					disabled={order?.review_status === "pending"}
					onSubmitted={onReviewSubmitted}
					orderId={orderId}
					transactionHash={txHash}
				/>
			) : null}
			<div className="flex items-center justify-center gap-1.5 py-1 text-muted-foreground">
				<LoaderCircle className="size-3.5 animate-spin" />
				<span className="text-xs">{m.checkout_checking()}</span>
			</div>
		</section>
	);
}
