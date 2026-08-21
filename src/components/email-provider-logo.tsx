import {
	SiCloudflare,
	SiMailgun,
	SiResend,
} from "@icons-pack/react-simple-icons";
import { Mail, Stamp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { EmailProviderId } from "#/features/settings/email-channels";

type ProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;
type ProviderIconDefinition = {
	brandColor?: boolean;
	color?: string;
	icon: ProviderIcon;
};

const emailProviderIcons: Record<EmailProviderId, ProviderIconDefinition> = {
	cloudflare_email: { brandColor: true, icon: SiCloudflare },
	mailgun: { brandColor: true, icon: SiMailgun },
	postmark: { color: "#FFB800", icon: Stamp },
	resend: { icon: SiResend },
	sendgrid: { icon: SendGridLogo },
	smtp: { icon: Mail },
};

export function EmailProviderLogo({
	className,
	providerId,
}: {
	className?: string;
	providerId: EmailProviderId;
}) {
	const definition = emailProviderIcons[providerId];
	const Icon = definition.icon;
	return (
		<Icon
			aria-hidden="true"
			className={className}
			color={
				definition.color ?? (definition.brandColor ? "default" : undefined)
			}
		/>
	);
}

function SendGridLogo(props: SVGProps<SVGSVGElement>) {
	const squares = [
		[2, 2],
		[9, 2],
		[9, 9],
		[16, 9],
		[2, 16],
		[9, 16],
		[16, 16],
	] as const;
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
			{squares.map(([x, y]) => (
				<rect
					fill="#1A82E2"
					height="6"
					key={`${x}-${y}`}
					rx="0.75"
					width="6"
					x={x}
					y={y}
				/>
			))}
		</svg>
	);
}
