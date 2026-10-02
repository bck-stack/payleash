import { AllCommunityModule, ModuleRegistry, colorSchemeVariable, themeQuartz, type ColDef, type GridApi, type GridReadyEvent } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, type ComponentProps } from "react";

// AG Grid Community: all community features (sorting, filtering, CSV export). No enterprise modules are used.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid Community with PayLeash's look: one theme that follows the page's light / dark setting
 * (the `data-ag-theme-mode` attribute on <body>, set by the app's theme switch).
 */
export const gridTheme = themeQuartz.withPart(colorSchemeVariable).withParams({
  fontFamily: "inherit",
  accentColor: "#0f6b5c",
  borderRadius: 8,
  wrapperBorderRadius: 10,
  headerFontWeight: 600,
  spacing: 7,
});

export const defaultColDef: ColDef = { sortable: true, filter: true, resizable: true, floatingFilter: true, minWidth: 90 };

export function Grid<T>(props: ComponentProps<typeof AgGridReact<T>>) {
  const theme = useMemo(() => gridTheme, []);
  return (
    <div className="grid-wrap">
      <AgGridReact<T> theme={theme} defaultColDef={defaultColDef} animateRows={false} {...props} />
    </div>
  );
}

export type { ColDef, GridApi, GridReadyEvent };
