import {
	clearCache,
	measureNaturalWidth,
	prepareWithSegments,
} from "@chenglou/pretext";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { NetworkBadge } from "#/components/crypto-icons/badge";
import { AssetLabel } from "#/components/crypto-icons/labels";
import { formatDecimalAmount } from "#/lib/format";
import { m } from "#/paraglide/messages";
import type { CheckoutOrder } from "../checkout-model";
import { CopyIconButton } from "./checkout-display";

const AMOUNT_TEXT_MAX_SIZE = 36;
const AMOUNT_TEXT_MIN_SIZE = 1;
const AMOUNT_TEXT_FONT_FAMILY = "Nunito Variable";
const AMOUNT_TEXT_FONT = `700 ${AMOUNT_TEXT_MAX_SIZE}px "${AMOUNT_TEXT_FONT_FAMILY}"`;
const AMOUNT_TEXT_PREPARE_OPTIONS = { wordBreak: "keep-all" } as const;
const AMOUNT_UNIT_SEPARATOR = "\u00A0";

export function OrderSummaryCard({
	activeNetwork,
	activeNetworkDisplayName,
	amountMode,
	onCopyAmount,
	order,
	tradeId,
}: {
	activeNetwork?: string;
	activeNetworkDisplayName?: string;
	amountMode: "order" | "payment";
	onCopyAmount: () => boolean | undefined | Promise<boolean | undefined>;
	order?: CheckoutOrder;
	tradeId: string;
}) {
	const topAmount =
		amountMode === "payment"
			? formatPaymentAmount(order)
			: formatOrderAmount(order);
	const amountLabel =
		amountMode === "payment" ? m.checkout_amount() : m.checkout_order_amount();
	const showNetwork = amountMode === "payment" && Boolean(activeNetwork);
	const showOrderAmountDetail = amountMode === "payment";

	return (
		<section className="mb-4 w-full rounded-2xl border bg-card px-6 pt-6 pb-5 text-card-foreground shadow-md">
			<p className="mb-1 font-medium text-muted-foreground text-sm">
				{amountLabel}
			</p>
			<div className="flex items-end justify-between gap-3">
				<ScaledAmountText>{topAmount}</ScaledAmountText>
				<CopyIconButton onClick={onCopyAmount} />
			</div>
			{showNetwork ? (
				<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
					{order?.token ? (
						<AssetLabel
							label={order.token}
							network={activeNetwork ?? ""}
							symbol={order.token}
						/>
					) : null}
					<NetworkBadge
						{...(activeNetworkDisplayName
							? { displayName: activeNetworkDisplayName }
							: {})}
						network={activeNetwork ?? ""}
					/>
				</div>
			) : null}
			<div className="mt-3 border-border/50 border-t pt-3">
				<table className="w-full border-separate border-spacing-y-1 text-muted-foreground text-sm">
					<tbody>
						{showOrderAmountDetail ? (
							<tr>
								<td className="w-px whitespace-nowrap pr-3">
									{m.checkout_order_amount()}
								</td>
								<td className="whitespace-nowrap font-medium text-card-foreground">
									{formatOrderAmount(order)}
								</td>
							</tr>
						) : null}
						<tr>
							<td className="w-px whitespace-nowrap pr-3">
								{m.checkout_order_id()}
							</td>
							<td className="break-all font-medium text-card-foreground">
								{order?.trade_id ?? tradeId}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>
	);
}

function ScaledAmountText({ children }: { children: string }) {
	const noWrapText = normalizeAmountText(children);
	const containerRef = useRef<HTMLSpanElement>(null);
	const [naturalWidth, setNaturalWidth] = useState(0);
	const [fontSize, setFontSize] = useState(AMOUNT_TEXT_MAX_SIZE);

	const updateFontSize = useCallback(() => {
		const container = containerRef.current;

		if (!container) {
			return;
		}

		const availableWidth = container.clientWidth;

		if (!(availableWidth && naturalWidth)) {
			return;
		}

		const nextFontSize = Math.max(
			AMOUNT_TEXT_MIN_SIZE,
			Math.min(
				AMOUNT_TEXT_MAX_SIZE,
				(AMOUNT_TEXT_MAX_SIZE * availableWidth) / naturalWidth,
			),
		);

		setFontSize((currentFontSize) =>
			Math.abs(currentFontSize - nextFontSize) < 0.5
				? currentFontSize
				: nextFontSize,
		);
	}, [naturalWidth]);

	useLayoutEffect(() => {
		setNaturalWidth(measureAmountTextNaturalWidth(noWrapText));
	}, [noWrapText]);

	useLayoutEffect(() => {
		updateFontSize();

		const container = containerRef.current;
		const resizeObserver = new ResizeObserver(updateFontSize);

		if (container) {
			resizeObserver.observe(container);
		}

		return () => {
			resizeObserver.disconnect();
		};
	}, [updateFontSize]);

	useLayoutEffect(() => {
		let mounted = true;

		document.fonts?.ready.then(() => {
			if (!mounted) {
				return;
			}

			clearCache();
			setNaturalWidth(measureAmountTextNaturalWidth(noWrapText));
		});

		return () => {
			mounted = false;
		};
	}, [noWrapText]);

	return (
		<span
			className="relative block min-w-0 flex-1 overflow-hidden leading-none"
			ref={containerRef}
		>
			<span
				className="block whitespace-nowrap font-bold font-nunito leading-none"
				style={{ fontSize }}
			>
				{noWrapText}
			</span>
		</span>
	);
}

function normalizeAmountText(text: string) {
	return text.replace(/\s+/g, AMOUNT_UNIT_SEPARATOR);
}

function measureAmountTextNaturalWidth(text: string) {
	return measureNaturalWidth(
		prepareWithSegments(text, AMOUNT_TEXT_FONT, AMOUNT_TEXT_PREPARE_OPTIONS),
	);
}

function formatOrderAmount(order?: CheckoutOrder) {
	return order?.amount == null
		? "--"
		: formatAmountWithUnit(order.amount, order.currency);
}

function formatPaymentAmount(order?: CheckoutOrder) {
	const amount = order?.actual_amount ?? order?.amount;
	const token = order?.actual_amount == null ? order?.currency : order?.token;
	return amount == null ? "--" : formatAmountWithUnit(amount, token);
}

function formatAmountWithUnit(amount: string, unit?: string) {
	const localized = formatDecimalAmount(amount);
	return unit ? `${localized}${AMOUNT_UNIT_SEPARATOR}${unit}` : localized;
}
