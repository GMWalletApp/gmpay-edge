import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import {
	type ColumnFilterConfig,
	useProTableUrlState,
} from "#/components/pro/table";

export function validateProTableSearch(search: Record<string, unknown>) {
	const result: {
		page?: number;
		pageSize?: number;
		q?: string;
		sort?: string;
		order?: "asc" | "desc";
	} = {};
	const page = positiveInteger(search.page);
	const pageSize = positiveInteger(search.pageSize);
	if (page) result.page = page;
	if (pageSize) result.pageSize = pageSize;
	if (typeof search.q === "string" && search.q) result.q = search.q;
	if (typeof search.sort === "string" && search.sort) result.sort = search.sort;
	if (search.order === "asc" || search.order === "desc")
		result.order = search.order;
	return result;
}

function positiveInteger(value: unknown) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function useCurrentProTableUrlState({
	searchColumnId,
	prefix = "",
	search: validatedSearch,
}: {
	searchColumnId?: string;
	prefix?: string;
	search?: Record<string, unknown>;
} = {}) {
	const locationSearch = useLocation({
		select: (location) => location.search as Record<string, unknown>,
	});
	const search = validatedSearch ?? locationSearch;
	const routerNavigate = useNavigate();
	const columnFilters = useMemo<ColumnFilterConfig[]>(
		() =>
			searchColumnId
				? [
						{
							columnId: searchColumnId,
							searchKey: `${prefix}q`,
						},
					]
				: [],
		[prefix, searchColumnId],
	);

	return useProTableUrlState({
		search,
		navigate: (options) => {
			void routerNavigate({
				search: options.search as never,
				...(options.replace === undefined ? {} : { replace: options.replace }),
			});
		},
		pagination: {
			pageKey: `${prefix}page`,
			pageSizeKey: `${prefix}pageSize`,
		},
		sorting: {
			sortKey: `${prefix}sort`,
			orderKey: `${prefix}order`,
		},
		columnFilters,
	});
}
