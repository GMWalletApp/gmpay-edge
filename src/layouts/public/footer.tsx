import { Link } from "@tanstack/react-router";
import { Activity, ArrowUpRight } from "lucide-react";
import { useSiteBrand } from "#/context/site-brand-provider";
import { AppTitle } from "#/layouts/components/app-title";
import { m } from "#/paraglide/messages";

export function PublicFooter() {
	const brand = useSiteBrand();
	const productLinks = [
		[m.public_footer_networks(), "/assets"],
		[m.public_footer_status(), "/status"],
		[m.public_sign_in(), "/sign-in"],
	] as const;
	const developerLinks = [
		[m.public_footer_api_reference(), "/docs"],
		[m.public_footer_openapi(), "/openapi.yaml"],
	] as const;
	return (
		<footer className="w-full border-t py-14 sm:py-16">
			<div className="container px-4">
				<div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_0.7fr_0.7fr] lg:gap-16">
					<div className="max-w-md sm:col-span-2 lg:col-span-1">
						<Link className="inline-flex" to="/">
							<AppTitle description />
						</Link>
						<p className="mt-5 text-muted-foreground text-sm leading-6">
							{m.public_footer_description()}
						</p>
						<Link
							className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-primary text-xs transition-colors hover:bg-primary/15"
							to="/status"
						>
							<Activity className="size-3.5" />
							<span className="font-medium">{m.public_footer_ready()}</span>
							<span className="size-1.5 rounded-full bg-primary" />
						</Link>
					</div>
					<FooterColumn
						links={productLinks}
						title={m.public_footer_product()}
					/>
					<FooterColumn
						links={developerLinks}
						title={m.public_footer_developers()}
					/>
				</div>
				<div className="mt-12 flex flex-col gap-2 text-muted-foreground text-xs sm:flex-row sm:items-center sm:justify-between">
					<p>
						{m.public_footer_copyright({
							year: new Date().getFullYear(),
							name: brand.name,
						})}
					</p>
					<p>{m.public_footer_platform()}</p>
				</div>
			</div>
		</footer>
	);
}

function FooterColumn({
	title,
	links,
}: {
	title: string;
	links: readonly (readonly [string, string])[];
}) {
	return (
		<nav aria-label={title}>
			<h2 className="font-semibold text-foreground text-sm">{title}</h2>
			<ul className="mt-5 grid gap-3.5 text-muted-foreground text-sm">
				{links.map(([label, href]) => (
					<li key={href}>
						<a
							className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
							href={href}
						>
							{label}
							{href.endsWith(".yaml") ? (
								<ArrowUpRight className="size-3" />
							) : null}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
