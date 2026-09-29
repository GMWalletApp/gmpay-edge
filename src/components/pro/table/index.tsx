import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	compareItems,
	type RankingInfo,
	rankItem,
} from "@tanstack/match-sorter-utils";
import {
	type Cell,
	type Column,
	type ColumnDef,
	type ColumnFiltersState,
	type ColumnPinningState,
	type FilterFn,
	flexRender,
	getCoreRowModel,
	getFacetedRowModel,
	getFacetedUniqueValues,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type OnChangeFn,
	type PaginationState,
	type Row,
	type RowSelectionState,
	type SortingFn,
	type SortingState,
	type Table,
	type TableOptions,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import {
	AlignJustify,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Check,
	GripVertical,
	Inbox,
	Pin,
	PinOff,
	RefreshCw,
	RotateCcw,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
	type CSSProperties,
	type Dispatch,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { ProButton, type ProButtonSize } from "../base/button";
import { CheckboxControl } from "../base/fields/checkbox";
import { Input } from "../base/fields/input";
import { Select } from "../base/fields/select";
import { ProPagination } from "../pagination";

export interface ProTableState {
	pagination: PaginationState;
	sorting: SortingState;
	columnFilters: ColumnFiltersState;
}

const TABLE_SIZE_OPTIONS = [
	{ value: "default", label: () => m.pro_table_density_comfortable() },
	{ value: "middle", label: () => m.pro_table_density_medium() },
	{ value: "compact", label: () => m.pro_table_density_compact() },
] as const;

type TableSize = (typeof TABLE_SIZE_OPTIONS)[number]["value"];

type ProTableSearch =
	| false
	| string
	| {
			columnId: string;
			placeholder?: string;
	  };

interface ProTableDragSortOptions<TData> {
	rowKey?: Extract<keyof TData, string | number>;
	onDragSortEnd?: (newData: TData[]) => void;
}

interface ProTableTableOptions {
	stickyHeader?: boolean;
	pinning?:
		| false
		| {
				value?: ColumnPinningState;
				onChange?: (value: ColumnPinningState) => void;
		  };
}

interface ProTableRenderContext<TData> {
	table: Table<TData>;
	rows: Row<TData>[];
	selectedRows: Row<TData>[];
	tableSize: TableSize;
	size?: ProButtonSize;
}

type ProTableToolbarSlot<TData> =
	| ReactNode
	| ((context: ProTableRenderContext<TData>) => ReactNode);

export type ColumnFilterConfig =
	| {
			columnId: string;
			searchKey: string;
			type?: "string";
			serialize?: (value: unknown) => unknown;
			deserialize?: (value: unknown) => unknown;
	  }
	| {
			columnId: string;
			searchKey: string;
			type: "array";
			serialize?: (value: unknown) => unknown;
			deserialize?: (value: unknown) => unknown;
	  };

export function useProTableUrlState(params: {
	search: Record<string, unknown>;
	navigate: (opts: {
		search:
			| true
			| Record<string, unknown>
			| ((
					prev: Record<string, unknown>,
			  ) => Partial<Record<string, unknown>> | Record<string, unknown>);
		replace?: boolean;
	}) => void;
	pagination?: {
		pageKey?: string;
		pageSizeKey?: string;
		defaultPage?: number;
		defaultPageSize?: number;
	};
	sorting?: {
		sortKey?: string;
		orderKey?: string;
	};
	columnFilters?: ColumnFilterConfig[];
}): {
	initialState: Partial<ProTableState>;
	onChange: (state: ProTableState) => void;
} {
	const {
		search,
		navigate,
		pagination: paginationCfg,
		sorting: sortingCfg,
		columnFilters: columnFiltersCfg,
	} = params;
	const pageKey = paginationCfg?.pageKey ?? "page";
	const pageSizeKey = paginationCfg?.pageSizeKey ?? "pageSize";
	const defaultPage = paginationCfg?.defaultPage ?? 1;
	const defaultPageSize = paginationCfg?.defaultPageSize ?? 10;
	const sortKey = sortingCfg?.sortKey ?? "sort";
	const orderKey = sortingCfg?.orderKey ?? "order";

	const initialState = useMemo<Partial<ProTableState>>(() => {
		const page =
			typeof search[pageKey] === "number"
				? search[pageKey]
				: Number(search[pageKey]);
		const pageSize =
			typeof search[pageSizeKey] === "number"
				? search[pageSizeKey]
				: Number(search[pageSizeKey]);

		const sortId = search[sortKey];

		const columnFilters: ColumnFiltersState = (columnFiltersCfg ?? []).flatMap<
			ColumnFiltersState[number]
		>((cfg) => {
			const value = cfg.deserialize
				? cfg.deserialize(search[cfg.searchKey])
				: search[cfg.searchKey];
			if (cfg.type === "array") {
				return Array.isArray(value) && value.length > 0
					? [{ id: cfg.columnId, value }]
					: [];
			}

			if (typeof value === "string" && value.trim() !== "") {
				return [{ id: cfg.columnId, value }];
			}
			return [];
		});

		const sorting: SortingState =
			typeof sortId === "string" && sortId.trim() !== ""
				? [{ id: sortId, desc: search[orderKey] === "desc" }]
				: [];

		return {
			pagination: {
				pageIndex: Math.max(
					0,
					(Number.isFinite(page) ? page : defaultPage) - 1,
				),
				pageSize: Number.isFinite(pageSize) ? pageSize : defaultPageSize,
			},
			sorting,
			columnFilters,
		};
	}, [
		columnFiltersCfg,
		defaultPage,
		defaultPageSize,
		orderKey,
		pageKey,
		pageSizeKey,
		search,
		sortKey,
	]);

	const onChange = useCallback(
		(state: ProTableState) => {
			const sorting = state.sorting[0];
			const patch: Record<string, unknown> = {
				[pageKey]: undefined,
				[pageSizeKey]: undefined,
				[sortKey]: undefined,
				[orderKey]: undefined,
			};

			const nextPage = state.pagination.pageIndex + 1;
			if (nextPage > defaultPage) patch[pageKey] = nextPage;
			if (state.pagination.pageSize !== defaultPageSize) {
				patch[pageSizeKey] = state.pagination.pageSize;
			}
			if (sorting) {
				patch[sortKey] = sorting.id;
				patch[orderKey] = "asc";
				if (sorting.desc) patch[orderKey] = "desc";
			}

			const filterValues = new Map(
				state.columnFilters.map((filter) => [filter.id, filter.value] as const),
			);
			for (const cfg of columnFiltersCfg ?? []) {
				const filterValue = filterValues.get(cfg.columnId);

				if (cfg.type === "array") {
					const value = Array.isArray(filterValue) ? filterValue : [];
					patch[cfg.searchKey] = undefined;
					if (value.length > 0) {
						patch[cfg.searchKey] = value;
						if (cfg.serialize) patch[cfg.searchKey] = cfg.serialize(value);
					}
					continue;
				}

				const value = typeof filterValue === "string" ? filterValue : "";
				patch[cfg.searchKey] = undefined;
				if (value.trim() !== "") {
					patch[cfg.searchKey] = value;
					if (cfg.serialize) patch[cfg.searchKey] = cfg.serialize(value);
				}
			}

			navigate({
				search: (prev) => ({
					...prev,
					...patch,
				}),
			});
		},
		[
			columnFiltersCfg,
			defaultPage,
			defaultPageSize,
			navigate,
			orderKey,
			pageKey,
			pageSizeKey,
			sortKey,
		],
	);

	return { initialState, onChange };
}

interface ColumnFilterMeta<TData> {
	options: Array<{
		label: string;
		value: string;
	}>;
	placeholder?: string;
	multiple?: boolean;
	searchable?: boolean;
	onFilter?: (value: string, record: TData) => boolean;
}

declare module "@tanstack/react-table" {
	interface ColumnMeta<TData, TValue> {
		pinned?: "left" | "right";
		align?: "left" | "center" | "right";
		className?: string;
		search?:
			| boolean
			| {
					placeholder?: string;
			  };
		filter?: ColumnFilterMeta<TData>;
	}
	interface FilterMeta {
		itemRank?: RankingInfo;
	}
}

interface ProTablePinnedColumnOffsets {
	left: Record<string, number>;
	right: Record<string, number>;
}

function useProTable<TData, TValue>({
	columns,
	data,
	setData,
	toolbarSearch,
	size,
	paginationOptions,
	dragSort,
	tableOptions,
	manual = false,
	requestTotal,
	loading,
	pagination,
	setPagination,
	sorting,
	setSorting,
	columnFilters,
	setColumnFilters,
}: {
	columns: ColumnDef<TData, TValue>[];
	data: TData[];
	setData: Dispatch<SetStateAction<TData[]>>;
	pagination: PaginationState;
	setPagination: Dispatch<SetStateAction<PaginationState>>;
	sorting: SortingState;
	setSorting: Dispatch<SetStateAction<SortingState>>;
	columnFilters: ColumnFiltersState;
	setColumnFilters: Dispatch<SetStateAction<ColumnFiltersState>>;
	toolbarSearch?: ProTableSearch;
	size?: ProButtonSize;
	paginationOptions?: false;
	dragSort?: false | ProTableDragSortOptions<TData>;
	tableOptions?: ProTableTableOptions;
	manual?: boolean;
	requestTotal?: number;
	loading?: boolean;
}) {
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [tableSize, setTableSize] = useState<TableSize>("default");
	const tableRef = useRef<HTMLTableElement>(null);
	const tableColumns = useMemo(
		() => withProTableColumnDefaults(columns, toolbarSearch),
		[columns, toolbarSearch],
	);
	const tableColumnIdsKey = getLeafColumnIds(tableColumns).join("\0");
	const rankedSortedRowModel = useMemo(() => {
		const sortedRowModel = getSortedRowModel<TData>();

		return (table: Table<TData>) => {
			const getSorted = sortedRowModel(table);

			return () => {
				const rowModel = getSorted();
				if (table.options.manualSorting || table.getState().sorting.length > 0)
					return rowModel;

				const rankedColumnId = rowModel.rows
					.flatMap((row) =>
						Object.keys(row.columnFiltersMeta).filter(
							(columnId) => !!row.columnFiltersMeta[columnId]?.itemRank,
						),
					)
					.at(0);
				if (!rankedColumnId) return rowModel;

				return {
					...rowModel,
					rows: sortRowsByRank(rowModel.rows, rankedColumnId),
					flatRows: sortRowsByRank(rowModel.flatRows, rankedColumnId),
				};
			};
		};
	}, []);
	const columnState = useProTableColumnState(tableColumns, tableOptions);
	useEffect(() => {
		const validIds = new Set(splitColumnIds(tableColumnIdsKey));
		setColumnVisibility((current) => {
			const next = Object.fromEntries(
				Object.entries(current).filter(([id]) => validIds.has(id)),
			);
			return Object.keys(next).length === Object.keys(current).length
				? current
				: next;
		});
	}, [tableColumnIdsKey]);
	const resetToFirstPage = useCallback(() => {
		setPagination((current) => ({ ...current, pageIndex: 0 }));
	}, [setPagination]);
	const handleSortingChange = useCallback<OnChangeFn<SortingState>>(
		(updater) => {
			setSorting(updater);
			resetToFirstPage();
		},
		[resetToFirstPage, setSorting],
	);
	const handleColumnFiltersChange = useCallback<OnChangeFn<ColumnFiltersState>>(
		(updater) => {
			setColumnFilters(updater);
			resetToFirstPage();
		},
		[resetToFirstPage, setColumnFilters],
	);
	const reactTableOptions: TableOptions<TData> = {
		data,
		columns: tableColumns,
		// URL-backed tables receive new data-array identities when navigation updates
		// the search string. Pagination is reset explicitly for sorting and filters,
		// so TanStack must not silently send a page change back to page one.
		autoResetPageIndex: false,
		state: {
			sorting,
			columnVisibility,
			rowSelection,
			columnFilters,
			columnOrder: columnState.columnOrder,
			columnPinning: columnState.columnPinning,
			pagination,
		},
		enableRowSelection: true,
		enableColumnPinning: columnState.pinningEnabled,
		onRowSelectionChange: setRowSelection,
		onSortingChange: handleSortingChange,
		onColumnFiltersChange: handleColumnFiltersChange,
		onColumnVisibilityChange: setColumnVisibility,
		onColumnOrderChange: columnState.setColumnOrder,
		onColumnPinningChange: columnState.handleColumnPinningChange,
		onPaginationChange: setPagination,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel:
			paginationOptions === false ? undefined : getPaginationRowModel(),
		getSortedRowModel: rankedSortedRowModel,
		getFacetedRowModel: getFacetedRowModel(),
		getFacetedUniqueValues: getFacetedUniqueValues(),
	};
	if (manual) {
		reactTableOptions.manualPagination = true;
		reactTableOptions.manualSorting = true;
		reactTableOptions.manualFiltering = true;
		reactTableOptions.rowCount = requestTotal;
	}
	if (dragSort && dragSort.rowKey !== undefined) {
		const rowKey = dragSort.rowKey;
		reactTableOptions.getRowId = (row) => String(row[rowKey]);
	}
	const table = useReactTable(reactTableOptions);
	const pageCount = table.getPageCount();

	useEffect(() => {
		if (
			paginationOptions === false ||
			loading ||
			pageCount <= 0 ||
			pagination.pageIndex < pageCount
		)
			return;
		setPagination((current) => ({ ...current, pageIndex: pageCount - 1 }));
	}, [
		loading,
		pageCount,
		pagination.pageIndex,
		paginationOptions,
		setPagination,
	]);

	const dragSortEnabled = !!dragSort;
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;

			const rows = table.getRowModel().rows;
			const oldIndex = rows.findIndex((row) => row.id === String(active.id));
			const newIndex = rows.findIndex((row) => row.id === String(over.id));
			if (oldIndex === -1 || newIndex === -1) return;

			const oldRow = rows[oldIndex];
			const newRow = rows[newIndex];
			if (!(oldRow && newRow)) return;
			const oldDataIndex = data.indexOf(oldRow.original);
			const newDataIndex = data.indexOf(newRow.original);
			if (oldDataIndex === -1 || newDataIndex === -1) return;

			const nextData = arrayMove(data, oldDataIndex, newDataIndex);
			if (nextData === data) return;

			setData(nextData);
			if (dragSort) dragSort.onDragSortEnd?.(nextData);
		},
		[data, dragSort, setData, table],
	);
	const pinnedOffsets = useProTablePinnedColumnOffsets(
		table,
		tableRef,
		dragSortEnabled,
	);
	const rows = table.getRowModel().rows;
	const selectedRows = table.getFilteredSelectedRowModel().rows;
	const visibleColumns = table.getVisibleLeafColumns();
	const visibleColumnCount = visibleColumns.length + (dragSortEnabled ? 1 : 0);
	const renderContext: ProTableRenderContext<TData> = {
		table,
		rows,
		selectedRows,
		tableSize,
		size,
	};

	return {
		table,
		tableRef,
		tableSize,
		setTableSize,
		rows,
		selectedRows,
		visibleColumns,
		visibleColumnCount,
		renderContext,
		pinnedOffsets,
		sensors,
		handleDragEnd,
		dragSortEnabled,
		defaultColumnOrder: columnState.defaultColumnOrder,
		defaultColumnPinning: columnState.defaultColumnPinning,
	};
}

function getColumnDefId<TData, TValue>(
	column: ColumnDef<TData, TValue>,
	index: number,
) {
	if (column.id) return column.id;
	if ("accessorKey" in column && typeof column.accessorKey === "string")
		return column.accessorKey;
	return String(index);
}

function getLeafColumnIds<TData, TValue>(
	columns: ColumnDef<TData, TValue>[],
): string[] {
	return columns.flatMap((column, index) =>
		"columns" in column && Array.isArray(column.columns)
			? getLeafColumnIds(column.columns)
			: getColumnDefId(column, index),
	);
}

function getSystemColumnPinning(id: string | undefined) {
	if (id === "select" || id === "drag") return "left";
	if (id === "actions" || id === "operation") return "right";
	return undefined;
}

function getPinnedColumnIds<TData, TValue>(
	columns: ColumnDef<TData, TValue>[],
	side: "left" | "right",
): string[] {
	return columns.flatMap((column, index) => {
		if ("columns" in column && Array.isArray(column.columns)) {
			return getPinnedColumnIds(column.columns, side);
		}
		const id = getColumnDefId(column, index);
		const pinned = column.meta?.pinned ?? getSystemColumnPinning(id);
		return pinned === side ? [id] : [];
	});
}

function useProTableColumnState<TData, TValue>(
	columns: ColumnDef<TData, TValue>[],
	tableOptions: ProTableTableOptions | undefined,
) {
	const pinningConfig =
		typeof tableOptions?.pinning === "object"
			? tableOptions.pinning
			: undefined;
	const pinningEnabled = tableOptions?.pinning !== false;
	const defaultColumnOrderKey = getLeafColumnIds(columns).join("\0");
	const defaultColumnOrder = splitColumnIds(defaultColumnOrderKey);
	const defaultColumnPinning = pinningEnabled
		? {
				left: getPinnedColumnIds(columns, "left"),
				right: getPinnedColumnIds(columns, "right"),
			}
		: {};
	const defaultColumnPinningKey = serializeColumnPinning(defaultColumnPinning);
	const [columnOrder, setColumnOrder] = useState<string[]>(defaultColumnOrder);
	const [internalColumnPinning, setInternalColumnPinning] =
		useState<ColumnPinningState>(defaultColumnPinning);
	const controlledPinning = pinningConfig?.value !== undefined;
	const columnPinning = pinningConfig?.value ?? internalColumnPinning;
	const previousColumnIds = useRef(new Set(defaultColumnOrder));
	const previousDefaultPinning = useRef(
		columnPinningById(defaultColumnPinning),
	);

	useEffect(() => {
		const nextDefaultColumnOrder = splitColumnIds(defaultColumnOrderKey);
		setColumnOrder((current) => {
			const remainingIds = new Set(nextDefaultColumnOrder);
			const next = [
				...current.filter((id) => remainingIds.delete(id)),
				...remainingIds,
			];
			return arraysEqual(current, next) ? current : next;
		});
	}, [defaultColumnOrderKey]);
	useEffect(() => {
		const nextDefaultColumnOrder = splitColumnIds(defaultColumnOrderKey);
		const validIds = new Set(nextDefaultColumnOrder);
		const nextDefaults = columnPinningById(
			deserializeColumnPinning(defaultColumnPinningKey),
		);
		const oldIds = previousColumnIds.current;
		const oldDefaults = previousDefaultPinning.current;

		setInternalColumnPinning((current) => {
			const nextById = columnPinningById(current);
			for (const id of Object.keys(nextById)) {
				if (!validIds.has(id)) delete nextById[id];
			}
			for (const id of nextDefaultColumnOrder) {
				if (!oldIds.has(id) || oldDefaults[id] !== nextDefaults[id]) {
					const side = nextDefaults[id];
					if (side) nextById[id] = side;
					else delete nextById[id];
				}
			}
			const next = columnPinningFromIds(nextDefaultColumnOrder, nextById);
			return serializeColumnPinning(current) === serializeColumnPinning(next)
				? current
				: next;
		});

		previousColumnIds.current = validIds;
		previousDefaultPinning.current = nextDefaults;
	}, [defaultColumnOrderKey, defaultColumnPinningKey]);

	const handleColumnPinningChange = useCallback<OnChangeFn<ColumnPinningState>>(
		(updater) => {
			if (controlledPinning) {
				const next =
					typeof updater === "function" ? updater(columnPinning) : updater;
				pinningConfig?.onChange?.(next);
				return;
			}
			setInternalColumnPinning((current) => {
				const next = typeof updater === "function" ? updater(current) : updater;
				pinningConfig?.onChange?.(next);
				return next;
			});
		},
		[columnPinning, controlledPinning, pinningConfig],
	);

	return {
		columnOrder,
		setColumnOrder,
		columnPinning,
		handleColumnPinningChange,
		defaultColumnOrder,
		defaultColumnPinning,
		pinningEnabled,
	};
}

function arraysEqual(left: string[], right: string[]) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function serializeColumnPinning(value: ColumnPinningState) {
	return `${(value.left ?? []).join("\0")}\u0001${(value.right ?? []).join("\0")}`;
}

function deserializeColumnPinning(value: string): ColumnPinningState {
	const [left = "", right = ""] = value.split("\u0001");
	return { left: splitColumnIds(left), right: splitColumnIds(right) };
}

function splitColumnIds(value: string) {
	return value ? value.split("\0") : [];
}

function columnPinningById(value: ColumnPinningState) {
	const result: Record<string, "left" | "right"> = {};
	for (const id of value.left ?? []) result[id] = "left";
	for (const id of value.right ?? []) result[id] = "right";
	return result;
}

function columnPinningFromIds(
	columnOrder: string[],
	value: Record<string, "left" | "right">,
): ColumnPinningState {
	return {
		left: columnOrder.filter((id) => value[id] === "left"),
		right: columnOrder.filter((id) => value[id] === "right"),
	};
}

function withProTableColumnDefaults<TData, TValue>(
	columns: ColumnDef<TData, TValue>[],
	toolbarSearch?: ProTableSearch,
): ColumnDef<TData, TValue>[] {
	return columns.map((column, index) => {
		const children =
			"columns" in column && Array.isArray(column.columns)
				? withProTableColumnDefaults(column.columns, toolbarSearch)
				: undefined;
		const filter = column.meta?.filter;
		const columnId = getColumnDefId(column, index);
		const search =
			column.meta?.search ?? getColumnSearchEnabled(toolbarSearch, columnId);
		const shouldApplyFilter = filter && column.filterFn === undefined;
		const shouldApplySearchFilter =
			search && !filter && column.filterFn === undefined;
		const shouldApplyFuzzySort = search && column.sortingFn === undefined;
		const systemPinned = getSystemColumnPinning(columnId);

		if (
			!children &&
			!shouldApplyFilter &&
			!shouldApplySearchFilter &&
			!shouldApplyFuzzySort &&
			!systemPinned
		) {
			return column;
		}

		return {
			...column,
			...(children ? { columns: children } : {}),
			...(systemPinned
				? {
						enableHiding: column.enableHiding ?? false,
						meta: {
							pinned: systemPinned,
							...column.meta,
							className: cn("w-8", column.meta?.className),
						},
					}
				: {}),
			...(shouldApplyFilter
				? {
						filterFn: getColumnFilterFn(filter),
					}
				: {}),
			...(shouldApplySearchFilter
				? {
						filterFn: ((row, columnId, filterValue, addMeta) => {
							const value = String(filterValue ?? "");
							if (!value) return true;

							const itemRank = rankItem(row.getValue(columnId), value);
							addMeta({ itemRank });
							return itemRank.passed;
						}) satisfies FilterFn<TData>,
					}
				: {}),
			...(shouldApplyFuzzySort
				? {
						sortingFn: ((rowA, rowB, columnId) => {
							const rankA = rowA.columnFiltersMeta[columnId]?.itemRank;
							const rankB = rowB.columnFiltersMeta[columnId]?.itemRank;

							if (rankA && rankB) {
								const rankSort = compareItems(rankA, rankB);
								if (rankSort !== 0) return rankSort;
							}

							return collator.compare(
								String(rowA.getValue(columnId) ?? ""),
								String(rowB.getValue(columnId) ?? ""),
							);
						}) satisfies SortingFn<TData>,
					}
				: {}),
		};
	});
}

function getColumnSearchEnabled(
	toolbarSearch: ProTableSearch | undefined,
	columnId: string,
) {
	if (toolbarSearch === false || toolbarSearch === undefined) return undefined;
	if (typeof toolbarSearch === "string") return toolbarSearch === columnId;
	return toolbarSearch.columnId === columnId;
}

function getColumnFilterFn<TData>(filter: ColumnFilterMeta<TData>) {
	if (filter.onFilter) {
		return ((row, _columnId, filterValue) => {
			if (
				filterValue === undefined ||
				filterValue === null ||
				filterValue === ""
			)
				return true;
			if (Array.isArray(filterValue)) {
				if (filterValue.length === 0) return true;
				return filterValue.some((value) =>
					filter.onFilter?.(String(value), row.original),
				);
			}
			return !!filter.onFilter?.(String(filterValue), row.original);
		}) satisfies FilterFn<TData>;
	}

	if (filter.multiple) {
		return ((row, columnId, filterValue) => {
			if (
				filterValue === undefined ||
				filterValue === null ||
				filterValue === ""
			)
				return true;
			const rowValue = row.getValue(columnId);
			if (Array.isArray(filterValue)) {
				if (filterValue.length === 0) return true;
				return filterValue.includes(rowValue);
			}
			return filterValue === rowValue;
		}) satisfies FilterFn<TData>;
	}

	return "equals";
}

function renderToolbarSlot<TData>(
	toolbar: false | ProTableToolbarSlot<TData> | undefined,
	context: ProTableRenderContext<TData>,
) {
	if (toolbar === false) return undefined;
	if (typeof toolbar === "function") return toolbar(context);
	return toolbar;
}

function getTablePaddingClass(size: TableSize) {
	if (size === "compact") return "py-1";
	if (size === "middle") return "py-2";
	return "py-3";
}

function getAriaSort(canSort: boolean, sorted: false | "asc" | "desc") {
	if (!canSort) return undefined;
	if (sorted === "asc") return "ascending";
	if (sorted === "desc") return "descending";
	return "none";
}

function renderSortIcon(sorted: false | "asc" | "desc") {
	if (sorted === "asc") return <ArrowUp size={14} />;
	if (sorted === "desc") return <ArrowDown size={14} />;
	return <ArrowUpDown size={14} className="opacity-40" />;
}

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function sortRowsByRank<TData>(rows: Row<TData>[], columnId: string) {
	return [...rows].sort((rowA, rowB) => {
		const rankA = rowA.columnFiltersMeta[columnId]?.itemRank;
		const rankB = rowB.columnFiltersMeta[columnId]?.itemRank;

		if (rankA && rankB) {
			const rankSort = compareItems(rankA, rankB);
			if (rankSort !== 0) return rankSort;
		}

		if (rankA) return -1;
		if (rankB) return 1;
		return rowA.index - rowB.index;
	});
}

function useProTablePinnedColumnOffsets<TData>(
	table: Table<TData>,
	tableRef: RefObject<HTMLTableElement | null>,
	dragSort: boolean,
): ProTablePinnedColumnOffsets {
	const [offsets, setOffsets] = useState<ProTablePinnedColumnOffsets>({
		left: {},
		right: {},
	});
	const visibleColumnKey = table
		.getVisibleLeafColumns()
		.map((column) => column.id)
		.join("\0");
	const leftPinnedKey = (table.getState().columnPinning.left ?? []).join("\0");
	const rightPinnedKey = (table.getState().columnPinning.right ?? []).join(
		"\0",
	);

	useLayoutEffect(() => {
		// These serialized keys intentionally retrigger measurement when pinning or visibility changes.
		void leftPinnedKey;
		void rightPinnedKey;
		void visibleColumnKey;
		const tableElement = tableRef.current;
		if (!tableElement) return;

		const updateOffsets = () => {
			const widths = new Map<string, number>();

			for (const element of tableElement.querySelectorAll<HTMLElement>(
				"[data-pro-table-column-id]",
			)) {
				const columnId = element.dataset.proTableColumnId;
				if (!columnId || widths.has(columnId)) continue;
				widths.set(columnId, element.getBoundingClientRect().width);
			}

			const next: ProTablePinnedColumnOffsets = { left: {}, right: {} };
			let left = dragSort ? 32 : 0;

			for (const column of table.getLeftVisibleLeafColumns()) {
				next.left[column.id] = left;
				left += widths.get(column.id) ?? column.getSize();
			}

			let right = 0;
			const rightColumns = table.getRightVisibleLeafColumns();
			for (let index = rightColumns.length - 1; index >= 0; index -= 1) {
				const column = rightColumns[index];
				if (!column) continue;
				next.right[column.id] = right;
				right += widths.get(column.id) ?? column.getSize();
			}

			setOffsets((current) =>
				arePinnedColumnOffsetsEqual(current, next) ? current : next,
			);
		};

		updateOffsets();
		if (typeof ResizeObserver === "undefined") return undefined;

		const observer = new ResizeObserver(updateOffsets);
		observer.observe(tableElement);
		for (const element of tableElement.querySelectorAll<HTMLElement>(
			"[data-pro-table-column-id]",
		)) {
			observer.observe(element);
		}

		return () => observer.disconnect();
	}, [
		dragSort,
		leftPinnedKey,
		rightPinnedKey,
		table,
		tableRef,
		visibleColumnKey,
	]);

	return offsets;
}

function arePinnedColumnOffsetsEqual(
	current: ProTablePinnedColumnOffsets,
	next: ProTablePinnedColumnOffsets,
) {
	for (const side of ["left", "right"] as const) {
		let currentCount = 0;
		let nextCount = 0;

		for (const [columnId, offset] of Object.entries(current[side])) {
			currentCount += 1;
			if (next[side][columnId] !== offset) return false;
		}

		for (const [columnId, offset] of Object.entries(next[side])) {
			nextCount += 1;
			if (current[side][columnId] !== offset) return false;
		}

		if (currentCount !== nextCount) return false;
	}

	return true;
}

export function ProTable<TData, TValue>({
	columns,
	data,
	request,
	requestKey,
	initialState,
	onChange,
	header,
	toolbar,
	toolbarSearch,
	size,
	toolbarDensity,
	toolbarColumns,
	onRefresh,
	bulkToolbar,
	pagination,
	dragSort,
	loading,
	layout,
	table,
	className,
}: {
	columns: ColumnDef<TData, TValue>[];
	data?: TData[];
	request?: (
		params: ProTableState,
		requestKey?: unknown,
	) =>
		| Promise<{ data: TData[]; total?: number }>
		| { data: TData[]; total?: number };
	requestKey?: unknown;
	initialState?: Partial<ProTableState>;
	onChange?: (state: ProTableState) => void;
	header?: ReactNode | ((context: ProTableRenderContext<TData>) => ReactNode);
	toolbar?: false | ProTableToolbarSlot<TData>;
	toolbarSearch?: ProTableSearch;
	size?: ProButtonSize;
	toolbarDensity?: boolean;
	toolbarColumns?: boolean;
	onRefresh?: () => void;
	bulkToolbar?: false | ProTableToolbarSlot<TData>;
	pagination?: false;
	dragSort?: false | ProTableDragSortOptions<TData>;
	loading?:
		| boolean
		| {
				rows?: number;
		  };
	layout?: "full" | "auto";
	table?: ProTableTableOptions;
	className?: string;
}) {
	const toolbarButtonSize = size ?? "icon";
	const [tableData, setTableData] = useState<TData[]>(data ?? []);
	const [requestLoading, setRequestLoading] = useState(false);
	const [requestError, setRequestError] = useState<unknown>();
	const [requestTotal, setRequestTotal] = useState<number>();
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
		initialState?.columnFilters ?? [],
	);
	const [sorting, setSorting] = useState<SortingState>(
		initialState?.sorting ?? [],
	);
	const [paginationState, setPagination] = useState<PaginationState>(
		initialState?.pagination ?? {
			pageIndex: 0,
			pageSize: 10,
		},
	);
	const state = useMemo<ProTableState>(
		() => ({ pagination: paginationState, sorting, columnFilters }),
		[paginationState, sorting, columnFilters],
	);
	const mountedRef = useRef(false);
	const onChangeRef = useRef(onChange);

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		const next = initialState?.pagination;
		if (!next) return;
		setPagination((current) =>
			current.pageIndex === next.pageIndex && current.pageSize === next.pageSize
				? current
				: next,
		);
	}, [initialState?.pagination]);

	useEffect(() => {
		const next = initialState?.sorting;
		if (!next) return;
		setSorting((current) =>
			JSON.stringify(current) === JSON.stringify(next) ? current : next,
		);
	}, [initialState?.sorting]);

	useEffect(() => {
		const next = initialState?.columnFilters;
		if (!next) return;
		setColumnFilters((current) =>
			JSON.stringify(current) === JSON.stringify(next) ? current : next,
		);
	}, [initialState?.columnFilters]);

	useEffect(() => {
		if (request) return;
		setTableData(data ?? []);
	}, [data, request]);

	useEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		onChangeRef.current?.(state);
	}, [state]);

	useEffect(() => {
		if (!request) return;

		let canceled = false;
		setRequestLoading(true);
		setRequestError(undefined);

		Promise.resolve(request(state, requestKey))
			.then((result) => {
				if (canceled) return;
				setTableData(result.data);
				setRequestTotal(result.total);
			})
			.catch((error) => {
				if (canceled) return;
				setRequestError(error);
				setTableData([]);
				setRequestTotal(undefined);
			})
			.finally(() => {
				if (!canceled) setRequestLoading(false);
			});

		return () => {
			canceled = true;
		};
	}, [request, requestKey, state]);

	const loadingRows = typeof loading === "object" ? (loading.rows ?? 5) : 5;
	const loadingEnabled =
		(loading !== undefined && loading !== false) || requestLoading;
	const proTable = useProTable({
		columns,
		data: tableData,
		setData: setTableData,
		toolbarSearch,
		size: toolbarButtonSize,
		paginationOptions: pagination,
		dragSort,
		tableOptions: table,
		manual: !!request,
		requestTotal,
		loading: loadingEnabled,
		pagination: paginationState,
		setPagination,
		sorting,
		setSorting,
		columnFilters,
		setColumnFilters,
	});
	const isFullLayout = (layout ?? "full") === "full";
	const headerContent =
		typeof header === "function" ? header(proTable.renderContext) : header;
	const toolbarActions = renderToolbarSlot(toolbar, proTable.renderContext);
	const bulkActions = renderToolbarSlot(bulkToolbar, proTable.renderContext);
	const tableState = proTable.table.getState();
	const stickyHeader = table?.stickyHeader ?? true;
	const paddingClass = getTablePaddingClass(proTable.tableSize);
	const content = (
		<>
			<div
				className={cn(
					"w-full max-w-full overflow-auto rounded-md border",
					"[scrollbar-gutter:auto] [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgba(148,163,184,0.45)_transparent] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-track]:shadow-none [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-0 [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/35",
				)}
			>
				<table
					ref={proTable.tableRef}
					data-slot="pro-table"
					className="w-full min-w-max caption-bottom text-sm"
				>
					<thead data-slot="pro-table-header" className="[&_tr]:border-b">
						{proTable.table.getHeaderGroups().map((headerGroup) => (
							<tr
								key={headerGroup.id}
								data-slot="pro-table-row"
								className={
									"border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
								}
							>
								{proTable.dragSortEnabled && (
									<th
										data-slot="pro-table-head-cell"
										className={cn(
											"h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
											"sticky left-0 z-20 w-8 bg-background pr-0 shadow-[6px_0_10px_-10px_hsl(var(--foreground)/0.45),1px_0_0_0_var(--border)] transition-colors duration-150 hover:bg-muted",
											stickyHeader && "top-0 z-30",
										)}
									/>
								)}
								{headerGroup.headers.map((header) => {
									const canSort =
										!proTable.dragSortEnabled && header.column.getCanSort();
									const sorted = header.column.getIsSorted();
									const sortHandler = canSort
										? header.column.getToggleSortingHandler()
										: undefined;
									const pinned = header.column.getIsPinned();
									const align =
										header.column.columnDef.meta?.align ??
										(pinned === "right" ? "right" : pinned || undefined);
									const ariaSort = getAriaSort(canSort, sorted);
									const headerContent = header.isPlaceholder ? null : (
										<div className="flex items-center gap-1.5">
											{flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)}
											{canSort && (
												<span
													className="text-muted-foreground"
													aria-hidden="true"
												>
													{renderSortIcon(sorted)}
												</span>
											)}
										</div>
									);

									return (
										<th
											key={header.id}
											data-slot="pro-table-head-cell"
											colSpan={header.colSpan}
											className={cn(
												"h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
												stickyHeader && "sticky top-0 z-10 bg-background",
												"transition-colors duration-150 hover:bg-muted",
												getPinnedColumnClassName(
													header.column,
													header.column.getIsPinned() && stickyHeader
														? "z-30"
														: undefined,
												),
												align === "center" &&
													"text-center [&>div]:justify-center",
												align === "right" && "text-right [&>div]:justify-end",
												align === "left" && "text-left [&>div]:justify-start",
												header.column.columnDef.meta?.className,
												canSort && "cursor-pointer select-none",
											)}
											style={getPinnedColumnStyle(
												header.column,
												proTable.pinnedOffsets,
												proTable.dragSortEnabled ? 32 : 0,
											)}
											data-pro-table-column-id={header.column.id}
											aria-sort={ariaSort}
											tabIndex={canSort ? 0 : undefined}
											onClick={sortHandler}
											onKeyDown={
												canSort
													? (event) => {
															if (event.key !== "Enter" && event.key !== " ")
																return;
															event.preventDefault();
															sortHandler?.(event);
														}
													: undefined
											}
										>
											{headerContent}
										</th>
									);
								})}
							</tr>
						))}
					</thead>
					<tbody
						data-slot="pro-table-body"
						className="[&_tr:last-child]:border-0"
					>
						<ProTableBody
							rows={proTable.rows}
							visibleColumns={proTable.visibleColumns}
							visibleColumnCount={proTable.visibleColumnCount}
							dragSort={proTable.dragSortEnabled}
							loading={loadingEnabled}
							loadingRows={loadingRows}
							paddingClass={paddingClass}
							emptyFallbackText={
								requestError ? m.pro_table_loadFailed() : undefined
							}
							pinnedOffsets={proTable.pinnedOffsets}
						/>
					</tbody>
				</table>
			</div>
			{isFullLayout && <div className="min-h-0 flex-1" aria-hidden="true" />}
			{pagination !== false && (
				<div className={isFullLayout ? "shrink-0" : undefined}>
					<ProPagination
						current={tableState.pagination.pageIndex + 1}
						pageCount={proTable.table.getPageCount()}
						pageSize={tableState.pagination.pageSize}
						total={proTable.table.getRowCount()}
						onPageChange={(page) => proTable.table.setPageIndex(page - 1)}
						onPageSizeChange={(pageSize) => {
							proTable.table.setPageSize(pageSize);
							proTable.table.setPageIndex(0);
						}}
					/>
				</div>
			)}
		</>
	);
	return (
		<div
			className={cn(
				"max-w-full",
				isFullLayout ? "flex h-full min-h-0 flex-col gap-3" : "space-y-3",
				className,
			)}
		>
			{headerContent != null && <div className="shrink-0">{headerContent}</div>}
			{toolbar !== false && (
				<ProTableToolbar
					table={proTable.table}
					columnFilters={columnFilters}
					disabled={loadingEnabled}
					search={toolbarSearch}
					actions={toolbarActions}
					size={size}
					columns={toolbarColumns ?? true}
					density={toolbarDensity ?? true}
					refresh={onRefresh}
					tableSize={proTable.tableSize}
					onTableSizeChange={proTable.setTableSize}
					columnOrder={tableState.columnOrder}
					columnPinning={tableState.columnPinning}
					columnVisibility={tableState.columnVisibility}
					defaultColumnOrder={proTable.defaultColumnOrder}
					defaultColumnPinning={proTable.defaultColumnPinning}
				/>
			)}
			{proTable.dragSortEnabled && !loadingEnabled ? (
				<DndContext
					sensors={proTable.sensors}
					collisionDetection={closestCenter}
					onDragEnd={proTable.handleDragEnd}
				>
					{content}
				</DndContext>
			) : (
				content
			)}
			{bulkActions != null && (
				<ProTableBulkActions table={proTable.table}>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{bulkActions}
					</div>
				</ProTableBulkActions>
			)}
		</div>
	);
}

function ProTableBulkActions<TData>({
	table,
	children,
}: {
	table: Table<TData>;
	children?: ReactNode;
}) {
	const selectedCount = table.getFilteredSelectedRowModel().rows.length;
	const toolbarRef = useRef<HTMLDivElement>(null);
	const [announcement, setAnnouncement] = useState("");

	useEffect(() => {
		if (selectedCount === 0) return;

		queueMicrotask(() =>
			setAnnouncement(
				m.pro_table_bulkActionsAvailable({
					count: selectedCount,
					rows: selectedCount === 1 ? m.pro_table_row() : m.pro_table_rows(),
				}),
			),
		);

		const timer = setTimeout(() => setAnnouncement(""), 3000);
		return () => clearTimeout(timer);
	}, [selectedCount]);

	function handleKeyDown(event: KeyboardEvent) {
		const buttons = toolbarRef.current?.querySelectorAll("button");
		if (!buttons?.length) return;

		const activeElement = document.activeElement;
		const currentIndex =
			activeElement instanceof HTMLButtonElement
				? Array.from(buttons).indexOf(activeElement)
				: -1;

		switch (event.key) {
			case "ArrowRight": {
				event.preventDefault();
				buttons[(currentIndex + 1) % buttons.length]?.focus();
				break;
			}
			case "ArrowLeft": {
				event.preventDefault();
				buttons[
					currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1
				]?.focus();
				break;
			}
			case "Home": {
				event.preventDefault();
				buttons[0]?.focus();
				break;
			}
			case "End": {
				event.preventDefault();
				buttons[buttons.length - 1]?.focus();
				break;
			}
			case "Escape": {
				const target =
					event.target instanceof HTMLElement ? event.target : null;
				const dropdownSelector =
					'[data-slot="dropdown-menu-trigger"], [data-slot="dropdown-menu-content"]';

				if (
					target?.closest(dropdownSelector) ||
					(activeElement instanceof HTMLElement &&
						activeElement.closest(dropdownSelector))
				) {
					return;
				}

				event.preventDefault();
				table.resetRowSelection();
				break;
			}
		}
	}

	if (selectedCount === 0) return null;

	return (
		<>
			<output aria-live="polite" aria-atomic="true" className="sr-only">
				{announcement}
			</output>

			<div
				ref={toolbarRef}
				role="toolbar"
				aria-label={m.pro_table_bulkActions({
					count: selectedCount,
					rows: selectedCount === 1 ? m.pro_table_row() : m.pro_table_rows(),
				})}
				aria-describedby="bulk-actions-description"
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				className={
					"fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl transition-all delay-100 duration-300 ease-out hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				}
			>
				<div
					className={
						"flex items-center gap-x-2 overflow-x-auto rounded-xl border bg-background/95 p-2 shadow-xl backdrop-blur-lg supports-backdrop-filter:bg-background/60"
					}
				>
					<ProButton
						variant="outline"
						className="rounded-full"
						title={m.pro_action_clearSelectionEscape()}
						tooltip={m.pro_action_clearSelectionEscape()}
						onClick={() => table.resetRowSelection()}
					>
						<X />
					</ProButton>

					<div aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />

					<div
						className="flex items-center gap-x-1 text-sm"
						id="bulk-actions-description"
					>
						<span
							className={
								"inline-flex min-w-8 items-center justify-center rounded-lg bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
							}
						>
							{selectedCount}
						</span>
						<span className="hidden sm:inline">
							{selectedCount === 1 ? m.pro_table_row() : m.pro_table_rows()}
						</span>
						{m.pro_table_selected()}
					</div>

					{children != null && (
						<>
							<div aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
							{children}
						</>
					)}
				</div>
			</div>
		</>
	);
}

function getSearchPlaceholder<TData>(
	searchColumn: Column<TData, unknown> | undefined,
	search: ProTableSearch | undefined,
	columnSearchPlaceholder: string | undefined,
) {
	if (!searchColumn) return undefined;
	const fallback =
		columnSearchPlaceholder ??
		m.pro_table_searchColumn({ column: searchColumn.id });
	if (typeof search === "object") return search.placeholder ?? fallback;
	return fallback;
}

function getFilterValue(rawFilterValue: unknown, values: string[]) {
	if (typeof rawFilterValue === "string") return rawFilterValue;
	if (Array.isArray(rawFilterValue) && values.length === rawFilterValue.length)
		return values;
	return undefined;
}

function getAutoFilterValues(autoRender: boolean, cellValue: unknown) {
	if (!autoRender) return [];
	if (typeof cellValue === "string") return [cellValue];
	if (
		Array.isArray(cellValue) &&
		cellValue.every((item) => typeof item === "string")
	) {
		return cellValue;
	}
	return [];
}

function ProTableToolbar<TData>({
	table,
	columnOrder,
	columnPinning,
	columnVisibility,
	defaultColumnOrder,
	defaultColumnPinning,
	search,
	columnFilters,
	actions,
	size,
	columns = true,
	density = true,
	refresh,
	disabled = false,
	tableSize = "default",
	onTableSizeChange,
}: {
	table: Table<TData>;
	columnOrder: string[];
	columnPinning: ColumnPinningState;
	columnVisibility: VisibilityState;
	defaultColumnOrder: string[];
	defaultColumnPinning: ColumnPinningState;
	search?: ProTableSearch;
	columnFilters: ColumnFiltersState;
	actions?: ReactNode;
	size?: ProButtonSize;
	columns?: boolean;
	density?: boolean;
	refresh?: () => void;
	disabled?: boolean;
	tableSize?: TableSize;
	onTableSizeChange?: (size: TableSize) => void;
}) {
	const toolbarButtonSize = size ?? "icon";
	const resetButtonSize = size ?? "sm";
	const searchColumn = getTableSearchColumn(table, search);
	const rawSearchValue = searchColumn
		? columnFilters.find((filter) => filter.id === searchColumn.id)?.value
		: undefined;
	const searchValue = typeof rawSearchValue === "string" ? rawSearchValue : "";
	const [searchInputValue, setSearchInputValue] = useState(searchValue);
	// An externally applied filter (URL state, reset) replaces the draft input
	// in the same render instead of one commit later.
	const [appliedSearchValue, setAppliedSearchValue] = useState(searchValue);
	if (searchValue !== appliedSearchValue) {
		setAppliedSearchValue(searchValue);
		setSearchInputValue(searchValue);
	}
	const searchTimer = useRef<number | undefined>(undefined);
	useEffect(
		() => () => {
			if (searchTimer.current) window.clearTimeout(searchTimer.current);
		},
		[],
	);
	const columnSearchPlaceholder =
		typeof searchColumn?.columnDef.meta?.search === "object"
			? searchColumn.columnDef.meta.search.placeholder
			: undefined;
	const searchPlaceholder = getSearchPlaceholder(
		searchColumn,
		search,
		columnSearchPlaceholder,
	);
	const filterControls = table.getAllColumns().flatMap((column) => {
		const filter = column.columnDef.meta?.filter;
		if (!filter) return [];
		const rawFilterValue = column.getFilterValue();
		const values = Array.isArray(rawFilterValue)
			? rawFilterValue.filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		const filterValue = getFilterValue(rawFilterValue, values);

		return [
			<Select
				key={`filter-${column.id}`}
				options={filter.options.map((option) => {
					const count = column.getFacetedUniqueValues().get(option.value);
					return {
						...option,
						label:
							count === undefined ? (
								option.label
							) : (
								<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
									<span className="truncate">{option.label}</span>
									<span className="shrink-0 font-mono text-xs text-muted-foreground">
										{count}
									</span>
								</span>
							),
					};
				})}
				placeholder={filter.placeholder ?? column.id}
				multiple={filter.multiple}
				searchable={filter.searchable ?? filter.options.length > 8}
				allowClear
				value={filterValue}
				onChange={(value) => column.setFilterValue(value)}
				className="h-9 w-full md:w-[180px]"
			/>,
		];
	});
	return (
		<div className="flex w-full flex-col gap-2 md:flex-row md:items-center md:justify-between">
			<div className="flex min-w-0 flex-1 flex-wrap items-start gap-2 md:items-center">
				{searchColumn && (
					<Input
						placeholder={searchPlaceholder}
						value={searchInputValue}
						onChange={(event) => {
							const value = event.target.value;
							setSearchInputValue(value);
							if (searchTimer.current) window.clearTimeout(searchTimer.current);
							searchTimer.current = window.setTimeout(
								() => searchColumn.setFilterValue(value || undefined),
								250,
							);
						}}
						disabled={disabled}
						allowClear={false}
						inputClassName="h-8"
						className="w-full md:w-[200px]"
					/>
				)}
				{filterControls}
				{table.getState().columnFilters.length > 0 && (
					<ProButton
						variant="ghost"
						size={resetButtonSize}
						disabled={disabled}
						onClick={() => table.resetColumnFilters()}
					>
						<X />
						{m.common_reset()}
					</ProButton>
				)}
			</div>
			<div className="flex flex-wrap items-center justify-end gap-2 md:ml-auto md:shrink-0">
				{actions}
				{refresh && (
					<ProButton
						size={toolbarButtonSize}
						variant="ghost"
						tooltip={m.common_refresh()}
						disabled={disabled}
						onClick={refresh}
					>
						<RefreshCw />
					</ProButton>
				)}
				{density && onTableSizeChange && (
					<DropdownMenuPrimitive.Root>
						<DropdownMenuPrimitive.Trigger asChild>
							<ProButton
								size={toolbarButtonSize}
								variant="ghost"
								tooltip={m.pro_action_density()}
								disabled={disabled}
							>
								<AlignJustify />
							</ProButton>
						</DropdownMenuPrimitive.Trigger>
						<DropdownMenuPrimitive.Portal>
							<DropdownMenuPrimitive.Content
								align="end"
								sideOffset={4}
								className={
									"z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
								}
							>
								{TABLE_SIZE_OPTIONS.map((option) => (
									<DropdownMenuPrimitive.Item
										key={option.value}
										className={
											"relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
										}
										onSelect={() => onTableSizeChange(option.value)}
									>
										<Check
											className={cn(
												"size-4",
												tableSize === option.value
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<span>{option.label()}</span>
									</DropdownMenuPrimitive.Item>
								))}
							</DropdownMenuPrimitive.Content>
						</DropdownMenuPrimitive.Portal>
					</DropdownMenuPrimitive.Root>
				)}
				{columns && (
					<DropdownMenuPrimitive.Root>
						<DropdownMenuPrimitive.Trigger asChild>
							<ProButton
								size={toolbarButtonSize}
								variant="ghost"
								tooltip={m.pro_action_columns()}
								disabled={disabled}
							>
								<SlidersHorizontal />
							</ProButton>
						</DropdownMenuPrimitive.Trigger>
						<DropdownMenuPrimitive.Portal>
							<DropdownMenuPrimitive.Content
								align="end"
								sideOffset={4}
								className={
									"z-50 max-h-(--radix-dropdown-menu-content-available-height) w-[240px] min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
								}
							>
								<ProTableColumnSettings
									table={table}
									columnOrder={columnOrder}
									columnPinning={columnPinning}
									columnVisibility={columnVisibility}
									defaultColumnOrder={defaultColumnOrder}
									defaultColumnPinning={defaultColumnPinning}
								/>
							</DropdownMenuPrimitive.Content>
						</DropdownMenuPrimitive.Portal>
					</DropdownMenuPrimitive.Root>
				)}
			</div>
		</div>
	);
}

function getTableSearchColumn<TData>(
	table: Table<TData>,
	search: ProTableSearch | undefined,
) {
	if (typeof search === "string") return table.getColumn(search);
	if (typeof search === "object") return table.getColumn(search.columnId);
	if (search === false) return undefined;

	return table
		.getAllLeafColumns()
		.find(
			(column) =>
				column.columnDef.meta?.search !== undefined &&
				column.columnDef.meta.search !== false,
		);
}

function ProTableColumnSettings<TData>({
	table,
	columnOrder: currentColumnOrder,
	columnPinning,
	columnVisibility,
	defaultColumnOrder,
	defaultColumnPinning,
}: {
	table: Table<TData>;
	columnOrder: string[];
	columnPinning: ColumnPinningState;
	columnVisibility: VisibilityState;
	defaultColumnOrder: string[];
	defaultColumnPinning: ColumnPinningState;
}) {
	const columns = table.getAllLeafColumns();
	const columnOrder = currentColumnOrder.length
		? currentColumnOrder
		: defaultColumnOrder;
	const columnLookup = new Map(
		columns.map((column) => [column.id, column] as const),
	);
	const orderedIds = new Set<string>();
	const orderedColumns = [
		...columnOrder.flatMap((columnId) => {
			const column = columnLookup.get(columnId);
			if (!column || orderedIds.has(column.id)) return [];
			orderedIds.add(column.id);
			return [column];
		}),
		...columns.filter((column) => {
			if (orderedIds.has(column.id)) return false;
			orderedIds.add(column.id);
			return true;
		}),
	];
	const hideableColumns = orderedColumns.filter(
		(column) =>
			column.getCanHide() && getSystemColumnPinning(column.id) === undefined,
	);
	const configurableColumnIds = hideableColumns.map((column) => column.id);
	const canPinColumns = table.options.enableColumnPinning !== false;
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	return (
		<>
			<div className="flex items-center justify-between px-2 py-1.5">
				<span className="text-xs font-medium text-muted-foreground">
					{m.pro_action_columns()}
				</span>
				<ProButton
					variant="ghost"
					size="xs"
					onClick={() => {
						table.resetColumnVisibility();
						table.setColumnOrder(defaultColumnOrder);
						if (canPinColumns) table.setColumnPinning(defaultColumnPinning);
					}}
				>
					<RotateCcw className="mr-1" />
					{m.common_reset()}
				</ProButton>
			</div>
			<div aria-hidden="true" className="h-px w-full shrink-0 bg-border" />
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={({ active, over }) => {
					if (!over || active.id === over.id) return;

					const oldIndex = configurableColumnIds.indexOf(String(active.id));
					const newIndex = configurableColumnIds.indexOf(String(over.id));
					if (oldIndex === -1 || newIndex === -1) return;
					const reordered = arrayMove(
						configurableColumnIds,
						oldIndex,
						newIndex,
					);
					let configurableIndex = 0;
					const configurableIds = new Set(configurableColumnIds);
					table.setColumnOrder(
						columnOrder.map((id) =>
							configurableIds.has(id)
								? (reordered[configurableIndex++] ?? id)
								: id,
						),
					);
				}}
			>
				<SortableContext
					items={configurableColumnIds}
					strategy={verticalListSortingStrategy}
				>
					<div className="py-1">
						{hideableColumns.map((column) => {
							let pinned: false | "left" | "right" = false;
							if (columnPinning.left?.includes(column.id)) pinned = "left";
							else if (columnPinning.right?.includes(column.id))
								pinned = "right";

							return (
								<SortableColumnItem
									key={column.id}
									column={column}
									visible={columnVisibility[column.id] !== false}
									pinned={pinned}
									canPin={canPinColumns}
								/>
							);
						})}
					</div>
				</SortableContext>
			</DndContext>
		</>
	);
}

function SortableColumnItem<TData>({
	column,
	visible,
	pinned,
	canPin,
}: {
	column: Column<TData, unknown>;
	visible: boolean;
	pinned: false | "left" | "right";
	canPin: boolean;
}) {
	const checkboxId = useId();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: column.id,
	});
	const canPinColumn = canPin && column.getCanPin();
	const leftPinned = pinned === "left";
	const rightPinned = pinned === "right";

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : 1,
			}}
			className="flex items-center gap-1 px-2 py-1.5 text-sm"
		>
			<ProButton
				variant="ghost"
				size="icon-xs"
				{...attributes}
				{...listeners}
				className="cursor-grab active:cursor-grabbing"
				aria-label={m.pro_action_dragToReorder()}
			>
				<GripVertical />
			</ProButton>
			{canPinColumn && (
				<ProButton
					variant={leftPinned ? "secondary" : "ghost"}
					size="icon-xs"
					className="shrink-0"
					aria-pressed={leftPinned}
					aria-label={
						leftPinned ? m.pro_action_unpinLeft() : m.pro_action_pinLeft()
					}
					title={leftPinned ? m.pro_action_unpinLeft() : m.pro_action_pinLeft()}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						column.pin(leftPinned ? false : "left");
					}}
				>
					{leftPinned ? <PinOff /> : <Pin />}
				</ProButton>
			)}
			<CheckboxControl
				id={checkboxId}
				checked={visible}
				disabled={!column.getCanHide()}
				onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
				onClick={(event) => event.stopPropagation()}
			/>
			<label
				htmlFor={checkboxId}
				className="min-w-0 flex-1 cursor-pointer select-none"
			>
				<span className="truncate">
					{typeof column.columnDef.header === "string"
						? column.columnDef.header
						: column.id}
				</span>
			</label>
			{canPinColumn && (
				<ProButton
					variant={rightPinned ? "secondary" : "ghost"}
					size="icon-xs"
					className="shrink-0"
					aria-pressed={rightPinned}
					aria-label={
						rightPinned ? m.pro_action_unpinRight() : m.pro_action_pinRight()
					}
					title={
						rightPinned ? m.pro_action_unpinRight() : m.pro_action_pinRight()
					}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						column.pin(rightPinned ? false : "right");
					}}
				>
					{rightPinned ? <PinOff /> : <Pin />}
				</ProButton>
			)}
		</div>
	);
}

function ProTableBody<TData>({
	rows,
	visibleColumns,
	visibleColumnCount,
	dragSort,
	loading,
	loadingRows,
	paddingClass,
	emptyFallbackText,
	pinnedOffsets,
}: {
	rows: Row<TData>[];
	visibleColumns: ReturnType<Row<TData>["getVisibleCells"]>[number]["column"][];
	visibleColumnCount: number;
	dragSort: boolean;
	loading: boolean;
	loadingRows: number;
	paddingClass: string;
	emptyFallbackText?: ReactNode;
	pinnedOffsets: ProTablePinnedColumnOffsets;
}) {
	const emptyRow = (
		<tr
			data-slot="pro-table-row"
			className={
				"border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
			}
		>
			<td
				data-slot="pro-table-cell"
				colSpan={visibleColumnCount}
				className={
					"p-2 align-middle whitespace-nowrap h-32 text-center text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]"
				}
			>
				<div className="flex flex-col items-center gap-2">
					<Inbox className="size-8 opacity-40" />
					<span className="text-sm">
						{emptyFallbackText ?? m.pro_table_noData()}
					</span>
				</div>
			</td>
		</tr>
	);

	if (loading) {
		return Array.from({ length: loadingRows }, (_, index) => (
			<tr
				// biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are fixed placeholders.
				key={`skeleton-row-${index}`}
				data-slot="pro-table-row"
				className={
					"group/row border-b transition-colors duration-150 hover:bg-muted has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
				}
			>
				{dragSort && (
					<td
						data-slot="pro-table-cell"
						className={
							"p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px] sticky left-0 z-20 w-8 bg-background pr-0 shadow-[6px_0_10px_-10px_hsl(var(--foreground)/0.45),1px_0_0_0_var(--border)] transition-colors duration-150 group-hover/row:bg-muted"
						}
					>
						<div
							data-slot="pro-table-skeleton"
							className="size-4 animate-pulse rounded-md bg-accent"
						/>
					</td>
				)}
				{visibleColumns.map((column) => (
					<td
						key={column.id}
						data-slot="pro-table-cell"
						className={getPinnedColumnClassName(
							column,
							cn(
								"p-2 align-middle whitespace-nowrap transition-colors duration-150 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
								column.columnDef.meta?.className,
							),
						)}
						style={getPinnedColumnStyle(
							column,
							pinnedOffsets,
							dragSort ? 32 : 0,
						)}
						data-pro-table-column-id={column.id}
					>
						<div
							data-slot="pro-table-skeleton"
							className="h-4 w-full animate-pulse rounded-md bg-accent"
						/>
					</td>
				))}
			</tr>
		));
	}

	if (dragSort) {
		return (
			<SortableContext
				items={rows.map((row) => row.id)}
				strategy={verticalListSortingStrategy}
			>
				{rows.map((row) => (
					<SortableRow key={row.id} row={row} paddingClass={paddingClass}>
						{row.getVisibleCells().map((cell) => (
							<BodyCell
								key={cell.id}
								cell={cell}
								dragSort
								paddingClass={paddingClass}
								pinnedOffsets={pinnedOffsets}
							/>
						))}
					</SortableRow>
				))}
				{rows.length === 0 && emptyRow}
			</SortableContext>
		);
	}

	if (rows.length === 0) return emptyRow;
	return rows.map((row) => (
		<tr
			key={row.id}
			data-slot="pro-table-row"
			data-state={row.getIsSelected() && "selected"}
			className={
				"group/row border-b transition-colors duration-150 hover:bg-muted has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
			}
		>
			{row.getVisibleCells().map((cell) => (
				<BodyCell
					key={cell.id}
					cell={cell}
					paddingClass={paddingClass}
					pinnedOffsets={pinnedOffsets}
				/>
			))}
		</tr>
	));
}

function BodyCell<TData>({
	cell,
	dragSort,
	paddingClass,
	pinnedOffsets,
}: {
	cell: Cell<TData, unknown>;
	dragSort?: boolean;
	paddingClass: string;
	pinnedOffsets: ProTablePinnedColumnOffsets;
}) {
	const meta = cell.column.columnDef.meta;
	const pinned = cell.column.getIsPinned();
	const align =
		meta?.align ?? (pinned === "right" ? "right" : pinned || undefined);
	const filter = meta?.filter;
	const autoRender = !!filter && cell.column.columnDef.cell === undefined;
	const cellValue = cell.getValue();
	const autoFilterValues = getAutoFilterValues(autoRender, cellValue);
	const autoFilterLabels = new Map(
		autoRender
			? filter.options.map((option) => [option.value, option.label] as const)
			: [],
	);
	const cellContent = renderTableCellContent({
		autoRender,
		autoFilterValues,
		autoFilterLabels,
		cell,
	});
	return (
		<td
			data-slot="pro-table-cell"
			className={getPinnedColumnClassName(
				cell.column,
				cn(
					"p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
					paddingClass,
					align === "center" && "text-center",
					align === "right" && "text-right",
					align === "left" && "text-left",
					meta?.className,
				),
			)}
			style={getPinnedColumnStyle(
				cell.column,
				pinnedOffsets,
				dragSort ? 32 : 0,
			)}
			data-pro-table-column-id={cell.column.id}
		>
			{cellContent}
		</td>
	);
}

function renderTableCellContent<TData>({
	autoRender,
	autoFilterValues,
	autoFilterLabels,
	cell,
}: {
	autoRender: boolean;
	autoFilterValues: string[];
	autoFilterLabels: Map<string, string>;
	cell: Cell<TData, unknown>;
}) {
	if (!autoRender)
		return flexRender(cell.column.columnDef.cell, cell.getContext());
	if (autoFilterValues.length === 0)
		return <span className="text-muted-foreground">-</span>;

	return (
		<div className="flex flex-wrap gap-1">
			{autoFilterValues.map((itemValue) => (
				<span
					key={itemValue}
					className={
						"inline-flex shrink-0 items-center justify-center rounded-sm bg-secondary px-2 py-0.5 text-xs font-normal text-secondary-foreground"
					}
				>
					{autoFilterLabels.get(itemValue) ?? itemValue}
				</span>
			))}
		</div>
	);
}

function SortableRow<TData>({
	row,
	children,
	paddingClass,
}: {
	row: Row<TData>;
	children: ReactNode;
	paddingClass: string;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: row.id,
	});

	return (
		<tr
			ref={setNodeRef}
			data-slot="pro-table-row"
			data-state={row.getIsSelected() && "selected"}
			className={
				"group/row border-b transition-colors duration-150 hover:bg-muted has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
			}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : 1,
				position: isDragging ? "relative" : undefined,
				zIndex: isDragging ? 10 : undefined,
			}}
		>
			<td
				data-slot="pro-table-cell"
				className={cn(
					"p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
					paddingClass,
					"sticky left-0 z-20 w-8 bg-background pr-0 shadow-[6px_0_10px_-10px_hsl(var(--foreground)/0.45),1px_0_0_0_var(--border)] transition-colors duration-150 group-hover/row:bg-muted group-data-[state=selected]/row:bg-muted",
				)}
			>
				<ProButton
					variant="ghost"
					size="icon-xs"
					{...attributes}
					{...listeners}
					className="cursor-grab active:cursor-grabbing"
					aria-label={m.pro_action_dragToReorder()}
				>
					<GripVertical />
				</ProButton>
			</td>
			{children}
		</tr>
	);
}

function getPinnedColumnClassName<TData>(
	column: Column<TData, unknown>,
	className?: string,
) {
	const pinned = column.getIsPinned();

	return cn(
		pinned &&
			"sticky z-10 bg-background transition-colors duration-150 group-hover/row:bg-muted group-data-[state=selected]/row:bg-muted",
		pinned === "left" &&
			column.getIsLastColumn("left") &&
			"shadow-[6px_0_10px_-10px_hsl(var(--foreground)/0.45),1px_0_0_0_var(--border)]",
		pinned === "right" &&
			column.getIsFirstColumn("right") &&
			"shadow-[-6px_0_10px_-10px_hsl(var(--foreground)/0.45),-1px_0_0_0_var(--border)]",
		className,
	);
}

function getPinnedColumnStyle<TData>(
	column: Column<TData, unknown>,
	offsets: ProTablePinnedColumnOffsets,
	leftOffset = 0,
): CSSProperties {
	const pinned = column.getIsPinned();
	const style: CSSProperties = {};

	if (pinned === "left") {
		style.left = `${offsets.left[column.id] ?? column.getStart("left") + leftOffset}px`;
	}

	if (pinned === "right") {
		style.right = `${offsets.right[column.id] ?? column.getAfter("right")}px`;
	}

	return style;
}
