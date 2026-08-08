export const orderIdPattern = /^\d{20}$/;

export function generateOrderId() {
	let orderId = "";
	while (orderId.length < 20) {
		const bytes = crypto.getRandomValues(new Uint8Array(20 - orderId.length));
		for (const byte of bytes) {
			if (byte < 250) orderId += String(byte % 10);
		}
	}
	return orderId;
}

export function isOrderId(value: string) {
	return orderIdPattern.test(value);
}
