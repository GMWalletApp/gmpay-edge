import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CodeXml, MessageCircle } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSiteBrand } from "#/context/site-brand-provider";
import {
	type CheckoutOrder,
	safeCheckoutReturnUrl,
} from "#/features/checkout/checkout-model";
import { OrderSummaryCard } from "#/features/checkout/components/order-summary-card";
import { PaymentDetailsPanel } from "#/features/checkout/components/payment-details-panel";
import { PaymentReviewDialog } from "#/features/checkout/components/payment-review-dialog";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";
import {
	CancelledPanel,
	ConfirmingPanel,
	ExpiredPanel,
	FailedPanel,
	NotFoundPanel,
	OverpaidPanel,
	PartiallyPaidPanel,
	RefundedPanel,
	SuccessPanel,
	TimeoutPanel,
} from "#/features/checkout/components/status-panels";
import { StepProgress } from "#/features/checkout/components/step-progress";
import {
	getCheckoutOrderFn,
	listCheckoutPaymentOptionsFn,
	selectCheckoutPaymentOptionFn,
	submitCheckoutTransactionFn,
} from "#/features/checkout/server/functions";
import { useNow } from "#/features/checkout/use-checkout-clock";
import { LocaleSwitch } from "#/layouts/components/locale-switch";
import { ThemeSwitch } from "#/layouts/components/theme-switch";
import { useVisiblePolling } from "#/lib/use-visible-polling";
import { m } from "#/paraglide/messages";

export function CheckoutPage({
	initialNow,
	orderId,
	initialOrder,
}: {
	initialNow: number;
	orderId: string;
	initialOrder: CheckoutOrder | null;
}) {
	const navigate = useNavigate();
	const brand = useSiteBrand();
	const [order, setOrder] = useState<CheckoutOrder | null>(initialOrder);
	const [txHash, setTxHash] = useState("");
	const [submittingTxHash, setSubmittingTxHash] = useState(false);
	const [optionDialogOpen, setOptionDialogOpen] = useState(false);
	const [selectingOption, setSelectingOption] = useState(false);
	const [pollFailed, setPollFailed] = useState(false);
	const now = useNow(initialNow, true);
	const statusDetail = order?.status_detail;
	const refreshOrder = useCallback(async () => {
		try {
			setOrder(await getCheckoutOrderFn({ data: { orderId } }));
			setPollFailed(false);
		} catch (error) {
			setPollFailed(true);
			throw error;
		}
	}, [orderId]);
	const pollingEnabled = Boolean(order && !isTerminal(statusDetail));
	const { pollAfterCurrent, pollNow } = useVisiblePolling(
		refreshOrder,
		5_000,
		pollingEnabled,
	);
	const shouldLoadPaymentOptions = Boolean(
		order && !isTerminal(statusDetail) && (!order.token || optionDialogOpen),
	);
	const paymentOptionsQuery = useQuery({
		queryKey: ["checkout", "payment-options", orderId],
		queryFn: () => listCheckoutPaymentOptionsFn({ data: { orderId } }),
		enabled: shouldLoadPaymentOptions,
	});
	const paymentOptions = paymentOptionsQuery.data ?? null;
	const backgroundStyle = useMemo<CSSProperties>(
		() => ({
			...(brand.backgroundColor && !brand.backgroundImageUrl
				? { backgroundColor: brand.backgroundColor }
				: {}),
			...(brand.backgroundImageUrl
				? {
						backgroundAttachment: "fixed",
						backgroundImage: brand.backgroundColor
							? `linear-gradient(${brand.backgroundColor}, ${brand.backgroundColor}), url(${JSON.stringify(brand.backgroundImageUrl)})`
							: `url(${JSON.stringify(brand.backgroundImageUrl)})`,
						backgroundPosition: "center",
						backgroundRepeat: "no-repeat",
						backgroundSize: "cover",
					}
				: {}),
		}),
		[brand.backgroundColor, brand.backgroundImageUrl],
	);
	const expiresAt = order?.expiration_time
		? new Date(order.expiration_time).getTime()
		: now;
	const remaining = Math.max(0, Math.round((expiresAt - now) / 1000));
	const timerRatio = Math.min(1, remaining / 900);
	const returnUrl =
		statusDetail === "paid" || statusDetail === "overpaid"
			? safeCheckoutReturnUrl(order?.redirect_url)
			: null;
	const reviewAction = order ? (
		<PaymentReviewDialog
			disabled={order.review_status === "pending"}
			onSubmitted={() =>
				setOrder((current) =>
					current ? { ...current, review_status: "pending" } : current,
				)
			}
			orderId={orderId}
			transactionHash={txHash}
		/>
	) : null;

	useEffect(() => {
		document.title = brand.title;
	}, [brand.title]);

	useEffect(() => {
		if (!returnUrl) return;
		const timer = window.setTimeout(
			() => window.location.assign(returnUrl),
			3000,
		);
		return () => window.clearTimeout(timer);
	}, [returnUrl]);

	let content: React.ReactNode;
	if (pollFailed) {
		content = (
			<TimeoutPanel
				onBack={() => navigate({ to: "/" })}
				onRetry={() => {
					setPollFailed(false);
					void pollNow().catch(() => undefined);
				}}
			/>
		);
	} else if (!order) {
		content = <NotFoundPanel onBack={() => navigate({ to: "/" })} />;
	} else if (statusDetail === "paid") {
		content = <SuccessPanel redirecting={Boolean(returnUrl)} />;
	} else if (statusDetail === "overpaid") {
		content = returnUrl ? (
			<SuccessPanel redirecting />
		) : (
			<OverpaidPanel
				asset={order.token ?? ""}
				received={order.received_amount ?? order.actual_amount ?? order.amount}
			/>
		);
	} else if (statusDetail === "refunded") {
		content = <RefundedPanel onBack={() => navigate({ to: "/" })} />;
	} else if (statusDetail === "cancelled") {
		content = <CancelledPanel onBack={() => navigate({ to: "/" })} />;
	} else if (statusDetail === "failed") {
		content = <FailedPanel onBack={() => navigate({ to: "/" })} />;
	} else if (statusDetail === "expired" || remaining === 0) {
		content = (
			<ExpiredPanel onBack={() => navigate({ to: "/" })}>
				{reviewAction}
			</ExpiredPanel>
		);
	} else if (statusDetail === "partially_paid") {
		content = (
			<PartiallyPaidPanel
				asset={order.token ?? ""}
				expected={order.actual_amount ?? order.amount}
				received={order.received_amount ?? "0"}
			>
				{reviewAction}
			</PartiallyPaidPanel>
		);
	} else if (statusDetail === "confirming") {
		content = (
			<ConfirmingPanel
				confirmations={order.confirmations ?? 0}
				required={order.required_confirmations ?? 1}
			>
				{reviewAction}
			</ConfirmingPanel>
		);
	} else if (!order.token) {
		content = (
			<>
				<StepProgress panel="select" totalSteps={2} />
				<OrderSummaryCard
					amountMode="order"
					onCopyAmount={() => copyText(order.amount)}
					order={order}
					tradeId={orderId}
				/>
				<SelectPaymentOptionPanel
					busy={selectingOption}
					loading={paymentOptionsQuery.isLoading}
					onConfirm={(option) => selectPaymentOption(option)}
					options={paymentOptions?.options ?? []}
					unavailableReason={paymentOptions?.unavailableReason}
				/>
			</>
		);
	} else {
		const activeNetworkDisplayName = networkName(order.network);
		content = optionDialogOpen ? (
			<SelectPaymentOptionPanel
				busy={selectingOption}
				loading={paymentOptionsQuery.isLoading}
				onBack={() => setOptionDialogOpen(false)}
				onConfirm={(option) => selectPaymentOption(option)}
				options={paymentOptions?.options ?? []}
				unavailableReason={paymentOptions?.unavailableReason}
			/>
		) : (
			<>
				<StepProgress panel="payment" totalSteps={2} />
				<OrderSummaryCard
					{...(order.network ? { activeNetwork: order.network } : {})}
					{...(activeNetworkDisplayName ? { activeNetworkDisplayName } : {})}
					amountMode="payment"
					onCopyAmount={() => copyText(order.actual_amount ?? order.amount)}
					order={order}
					tradeId={orderId}
				/>
				<PaymentDetailsPanel
					onCopyAddress={() => copyText(order.receive_address ?? "")}
					onChangePaymentOption={() => setOptionDialogOpen(true)}
					onSubmitTxHash={async () => {
						if (!txHash.trim()) {
							toast.error(m.checkout_tx_hash_required());
							return false;
						}
						setSubmittingTxHash(true);
						try {
							const result = await submitCheckoutTransactionFn({
								data: { orderId, transactionHash: txHash },
							});
							if (result.status !== "accepted") {
								toast.error(transactionSubmissionMessage(result.status));
								return false;
							}
							toast.success(m.checkout_tx_hash_submitted());
							await pollAfterCurrent();
							return true;
						} catch {
							toast.error(m.common_request_failed());
							return false;
						} finally {
							setSubmittingTxHash(false);
						}
					}}
					onTxHashChange={setTxHash}
					order={order}
					orderId={orderId}
					onReviewSubmitted={() =>
						setOrder((current) =>
							current ? { ...current, review_status: "pending" } : current,
						)
					}
					paymentFlow="chain"
					remaining={remaining}
					showChangePaymentOption={Boolean(
						paymentOptions?.selectable && paymentOptions.options.length > 1,
					)}
					showTxHashSubmit={!order.payment_url}
					showReviewSubmit={!order.payment_url}
					submittingTxHash={submittingTxHash}
					timeColor={
						remaining < 180
							? "#ef4444"
							: remaining < 450
								? "#f97316"
								: "#22c55e"
					}
					timerRatio={timerRatio}
					txHash={txHash}
				/>
			</>
		);
	}

	async function selectPaymentOption(option: {
		receivingMethodId: string;
		paymentMethodId: string;
	}) {
		setSelectingOption(true);
		try {
			await selectCheckoutPaymentOptionFn({
				data: {
					orderId,
					receivingMethodId: option.receivingMethodId,
					paymentMethodId: option.paymentMethodId,
				},
			});
			await Promise.all([pollAfterCurrent(), paymentOptionsQuery.refetch()]);
			setOptionDialogOpen(false);
			toast.success(m.checkout_payment_option_changed());
		} catch {
			toast.error(m.checkout_payment_option_failed());
		} finally {
			setSelectingOption(false);
		}
	}
	return (
		<main
			className="min-h-svh bg-background text-foreground"
			style={backgroundStyle}
		>
			<div className="mx-auto flex min-h-svh w-full max-w-sm flex-col px-5">
				<header className="flex items-center justify-between pt-8 pb-6">
					<Link to="/" className="flex min-w-0 items-center gap-2">
						<img
							alt={brand.name}
							className="size-8 shrink-0 object-contain"
							height={32}
							src={brand.logoUrl}
							width={32}
						/>
						<span className="truncate font-semibold text-lg tracking-tight">
							{brand.name}
						</span>
					</Link>
					<div className="flex items-center gap-1">
						<LocaleSwitch />
						<ThemeSwitch />
					</div>
				</header>
				<div className="flex-1">{content}</div>
				{brand.supportUrl ? (
					<a
						aria-label={m.checkout_customer_service()}
						className="fixed right-5 bottom-5 z-20 flex h-12 items-center gap-2 rounded-full bg-primary px-4 font-medium text-primary-foreground text-sm shadow-lg transition hover:opacity-90"
						href={brand.supportUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						<MessageCircle className="size-4" />
						<span>{m.checkout_customer_service()}</span>
					</a>
				) : null}
				<footer className="flex flex-wrap items-center justify-center gap-2.5 py-6 text-muted-foreground text-xs">
					<span className="flex items-center gap-1.5">
						{m.checkout_powered_by()}
						<strong className="text-foreground">{brand.name}</strong>
					</span>
					<span className="opacity-30">|</span>
					<a
						className="flex items-center gap-1 font-semibold text-foreground hover:opacity-70"
						href="https://github.com/GMwalletApp/gmpay-edge"
						rel="noopener noreferrer"
						target="_blank"
					>
						<CodeXml className="size-3.5" />
						{m.checkout_open_source_on()}
					</a>
				</footer>
			</div>
		</main>
	);
}

function isTerminal(status?: string) {
	return [
		"paid",
		"overpaid",
		"expired",
		"cancelled",
		"failed",
		"refunded",
	].includes(status ?? "");
}

function networkName(network?: string) {
	return network === "tron" ? "TRON · TRC20" : network?.toUpperCase();
}

function transactionSubmissionMessage(
	status: "not_found" | "mismatch" | "unavailable",
) {
	if (status === "not_found") return m.checkout_tx_hash_not_found();
	if (status === "mismatch") return m.checkout_tx_hash_mismatch();
	return m.checkout_tx_hash_unavailable();
}

async function copyText(value: string) {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		toast.error(m.common_copy_failed());
		return false;
	}
}
