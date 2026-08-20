import { ArrowLeft, Building2, Link2, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AssetLabel, NetworkLabel } from "#/components/crypto-icons/labels";
import { Button } from "#/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { listCheckoutPaymentOptionsFn } from "#/features/checkout/server/functions";
import { m } from "#/paraglide/messages";

type Option = NonNullable<
	Awaited<ReturnType<typeof listCheckoutPaymentOptionsFn>>
>["options"][number];
type RailKind = Option["railKind"];

export function SelectPaymentOptionPanel({
	busy,
	onBack,
	onConfirm,
	options,
}: {
	busy: boolean;
	onBack?: () => void;
	onConfirm: (option: Option) => void;
	options: Option[];
}) {
	const kinds = useMemo(
		() => [...new Set(options.map((option) => option.railKind))],
		[options],
	);
	const [kind, setKind] = useState<RailKind | "">("");
	const [receivingMethodId, setReceivingMethodId] = useState("");
	const [paymentMethodId, setPaymentMethodId] = useState("");
	useEffect(() => {
		if (!kind && kinds[0]) setKind(kinds[0]);
	}, [kind, kinds]);
	const kindOptions = options.filter((option) => option.railKind === kind);
	const receivingMethods = Array.from(
		new Map(
			kindOptions.map((option) => [
				option.receivingMethodId,
				{
					id: option.receivingMethodId,
					name: option.receivingMethodName,
					network: option.network,
					networkName: option.networkName,
				},
			]),
		).values(),
	);
	useEffect(() => {
		if (!receivingMethods.some((method) => method.id === receivingMethodId))
			setReceivingMethodId(receivingMethods[0]?.id ?? "");
	}, [receivingMethodId, receivingMethods]);
	const assets = kindOptions.filter(
		(option) => option.receivingMethodId === receivingMethodId,
	);
	useEffect(() => {
		if (!assets.some((asset) => asset.paymentMethodId === paymentMethodId))
			setPaymentMethodId(assets[0]?.paymentMethodId ?? "");
	}, [assets, paymentMethodId]);
	const selected = assets.find(
		(option) => option.paymentMethodId === paymentMethodId,
	);

	return (
		<section className="w-full pb-4">
			<div className="mb-3 flex items-center gap-2">
				{onBack ? (
					<Button
						aria-label={m.checkout_back()}
						className="size-8 rounded-full"
						onClick={onBack}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft />
					</Button>
				) : null}
				<p className="font-semibold text-base">
					{m.checkout_select_receiving_method()}
				</p>
			</div>
			{kinds.length > 1 ? (
				<div className="mb-4 grid grid-cols-3 gap-2">
					{kinds.map((value) => (
						<Button
							className="h-auto min-h-16 flex-col gap-1 rounded-xl px-2 py-2"
							key={value}
							onClick={() => {
								setKind(value);
								setReceivingMethodId("");
								setPaymentMethodId("");
							}}
							variant={kind === value ? "default" : "outline"}
						>
							{kindIcon(value)}
							<span className="text-xs">{kindLabel(value)}</span>
						</Button>
					))}
				</div>
			) : null}
			<div className="mb-4 grid grid-cols-2 gap-2">
				<div className="min-w-0">
					<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						{kindLabel(kind)}
					</p>
					<Select
						disabled={!receivingMethods.length}
						onValueChange={(value) => {
							setReceivingMethodId(value);
							setPaymentMethodId("");
						}}
						value={receivingMethodId}
					>
						<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{receivingMethods.map((method) => (
								<SelectItem key={method.id} value={method.id}>
									<NetworkLabel
										displayName={method.name.trim() || method.networkName}
										network={method.network}
									/>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="min-w-0">
					<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						{m.common_currency()}
					</p>
					<Select
						disabled={!assets.length}
						onValueChange={setPaymentMethodId}
						value={paymentMethodId}
					>
						<SelectTrigger className="h-12.5 w-full rounded-xl bg-card">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{assets.map((option) => (
								<SelectItem
									key={option.paymentMethodId}
									value={option.paymentMethodId}
								>
									<AssetLabel
										label={option.asset}
										network={option.network}
										symbol={option.asset}
									/>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			<Button
				className="h-12 w-full rounded-xl text-base"
				disabled={busy || !selected}
				onClick={() => selected && onConfirm(selected)}
			>
				{m.common_confirm()}
			</Button>
		</section>
	);
}

function kindLabel(kind: RailKind | "") {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	if (kind === "wallet") return m.nav_wallets();
	return m.orders_receiving_type();
}

function kindIcon(kind: RailKind) {
	if (kind === "chain") return <Link2 className="size-5" />;
	if (kind === "exchange") return <Building2 className="size-5" />;
	return <WalletCards className="size-5" />;
}
