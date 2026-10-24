import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MenuItem,
  MenuSubTrigger,
  menuRowContentInset,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import { WorkspaceLabelSwatchRow, workspaceLabelColorName } from "@/workspace-labels/swatch";
import type { WorkspaceAccent } from "./model";

const COLOR_PAGE_ID = "tabColor";

export interface TabColorMenu {
  /** The "Color" row; null when the tab menu has no color entry. */
  trigger: ReactElement | null;
  /** The page the row opens; pass to the menu surface. */
  pages: readonly MenuPageDefinition[];
}

type ColorEntry = Extract<WorkspaceTabMenuEntry, { kind: "color" }>;

/** The tab context menu's "Color" row and its page: ten swatches and "None". */
export function useTabColorMenu(entry: ColorEntry | null): TabColorMenu {
  return useMemo(() => {
    if (!entry) return { trigger: null, pages: [] };
    return {
      trigger: (
        <MenuSubTrigger
          id={COLOR_PAGE_ID}
          value={entry.selected ? workspaceLabelColorName(entry.selected) : entry.noneLabel}
          testID={entry.testID}
        >
          {entry.label}
        </MenuSubTrigger>
      ),
      pages: [
        {
          id: COLOR_PAGE_ID,
          title: entry.label,
          content: <TabColorPage entry={entry} />,
        },
      ],
    };
  }, [entry]);
}

function TabColorPage({ entry }: { entry: ColorEntry }): ReactElement {
  const { selectItem } = useMenuContext("TabColorPage");
  const { onChange } = entry;
  // Through `selectItem` like any row: the menu closes after the pick and iOS gets its grace.
  const handleChange = useCallback(
    (accent: WorkspaceAccent) => selectItem(() => onChange(accent), true),
    [onChange, selectItem],
  );
  const handleNone = useCallback(() => onChange(null), [onChange]);
  return (
    <>
      <View style={styles.swatches}>
        <WorkspaceLabelSwatchRow
          value={entry.selected}
          onChange={handleChange}
          testID={`${entry.testID}-swatches`}
        />
      </View>
      <MenuItem
        selected={entry.selected === null}
        onSelect={handleNone}
        testID={`${entry.testID}-none`}
      >
        {entry.noneLabel}
      </MenuItem>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The swatches start where a row's label starts; see workspace-labels/picker.tsx.
  swatches: {
    paddingHorizontal: menuRowContentInset(theme),
    paddingVertical: theme.spacing[2],
  },
}));
