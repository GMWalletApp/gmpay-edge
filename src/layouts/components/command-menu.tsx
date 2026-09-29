import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { ScrollArea } from "#/components/ui/scroll-area";
import { useSearch } from "#/context/search-provider";
import { m } from "#/paraglide/messages";
import { useNavigation } from "./navigation-context";
import type { SidebarData } from "./types";

export function commandMenuGroups(navigation: SidebarData) {
	return navigation.navGroups.flatMap((group) => {
		const items = group.items.flatMap((navItem) => {
			if (navItem.url)
				return [
					{
						key: String(navItem.url),
						title: navItem.title,
						value: navItem.title,
						url: navItem.url,
					},
				];
			return (navItem.items ?? []).map((item) => ({
				key: String(item.url),
				title: `${navItem.title} · ${item.title}`,
				value: `${navItem.title} ${item.title}`,
				url: item.url,
			}));
		});
		return items.length ? [{ id: group.id, title: group.title, items }] : [];
	});
}

export function CommandMenu() {
	const navigate = useNavigate();
	const { open, setOpen } = useSearch();
	const { navigation } = useNavigation();
	const groups = commandMenuGroups(navigation);

	const runCommand = (command: () => unknown) => {
		setOpen(false);
		command();
	};

	return (
		<CommandDialog modal open={open} onOpenChange={setOpen}>
			<CommandInput placeholder={m.layout_commandPlaceholder()} />
			<CommandList>
				<ScrollArea type="hover" className="h-72 pe-1">
					<CommandEmpty>{m.layout_commandEmpty()}</CommandEmpty>
					{groups.map((group) => (
						<CommandGroup key={group.id} heading={group.title}>
							{group.items.map((item) => (
								<CommandItem
									key={item.key}
									value={item.value ?? item.title}
									onSelect={() => runCommand(() => navigate({ to: item.url }))}
								>
									<div className="flex size-4 items-center justify-center">
										<ArrowRight className="size-2 text-muted-foreground/80" />
									</div>
									{item.title}
								</CommandItem>
							))}
						</CommandGroup>
					))}
				</ScrollArea>
			</CommandList>
		</CommandDialog>
	);
}
