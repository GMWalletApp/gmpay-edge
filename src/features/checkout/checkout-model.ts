export type CheckoutPanelState =
	| "loading"
	| "method"
	| "select"
	| "payment"
	| "success"
	| "expired"
	| "timeout"
	| "not-found";
export type PaymentFlowKind = "chain" | "okpay";
export interface CheckoutOrder {
	trade_id: string;
	external_order_id?: string;
	amount: string;
	actual_amount?: string;
	token?: string;
	currency?: string;
	network?: string;
	payment_url?: string;
	receive_address?: string;
	expiration_time?: string;
	redirect_url?: string;
	created_at?: string;
	status?: GmpayStatus;
	status_detail?: OrderStatus;
	received_amount_units?: string;
	received_amount?: string;
	confirmations?: number;
	required_confirmations?: number;
	review_status?: "pending" | "approved" | "rejected";
}

export function safeCheckoutReturnUrl(value?: string) {
	return safeHttpsUrl(value);
}

export function safeHostedPaymentUrl(value?: string) {
	return safeHttpsUrl(value);
}

function safeHttpsUrl(value?: string) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			url.username === "" &&
			url.password === ""
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

import type { GmpayStatus } from "#/features/orders/gmpay-status";
import type { OrderStatus } from "#/features/orders/schema";
