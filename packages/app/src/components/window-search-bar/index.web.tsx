import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { Text, View, type ViewStyle } from "react-native";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { Theme } from "@/styles/theme";
import {
  applyWindowSearchHighlights,
  clearWindowSearchHighlights,
  collectWindowSearchRanges,
  installWindowSearchHighlightStyles,
  scrollWindowSearchRangeIntoView,
} from "./window-search-highlights.web";
import { stepSearchMatchIndex } from "./window-search-match";

const ThemedSearch = withUnistyles(Search);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const noDragStyle = { WebkitAppRegion: "no-drag" } as unknown as ViewStyle;
const WINDOW_SEARCH_BAR_DATASET = { windowSearchBar: "true" };

export interface WindowSearchBarProps {
  contentRef?: RefObject<View | null>;
}

const MUTATION_DEBOUNCE_MS = 140;

function resolveSearchRoot(contentRef?: RefObject<View | null>): HTMLElement | null {
  if (contentRef?.current) {
    return contentRef.current as unknown as HTMLElement;
  }
  if (typeof document === "undefined") return null;
  return document.getElementById("root") ?? document.body;
}

function WindowSearchControls({
  matchCount,
  matchLabel,
  onPrev,
  onNext,
  onClear,
}: {
  matchCount: number;
  matchLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onClear: () => void;
}): ReactElement {
  return (
    <View style={styles.controls}>
      <Text
        testID="window-search-count"
        style={[styles.countText, matchCount === 0 && styles.countTextEmpty]}
      >
        {matchLabel}
      </Text>
      <ToolbarButton
        testID="window-search-prev"
        onPress={onPrev}
        disabled={matchCount === 0}
        label="Previous match"
        compact
      >
        <ThemedChevronUp size={13} uniProps={mutedColorMapping} />
      </ToolbarButton>
      <ToolbarButton
        testID="window-search-next"
        onPress={onNext}
        disabled={matchCount === 0}
        label="Next match"
        compact
      >
        <ThemedChevronDown size={13} uniProps={mutedColorMapping} />
      </ToolbarButton>
      <ToolbarButton testID="window-search-clear" onPress={onClear} label="Clear search" compact>
        <ThemedX size={13} uniProps={mutedColorMapping} />
      </ToolbarButton>
    </View>
  );
}

export function WindowSearchBar({ contentRef }: WindowSearchBarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<EditingTextInputHandle>(null);
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;

  useEffect(() => installWindowSearchHighlightStyles(), []);

  const refreshMatches = useCallback(
    (nextQuery: string, options: { scrollToActive?: boolean; resetIndex?: boolean } = {}) => {
      const root = resolveSearchRoot(contentRef);
      const trimmed = nextQuery.trim();
      if (!trimmed || !root) {
        rangesRef.current = [];
        setMatchCount(0);
        setActiveIndex(0);
        clearWindowSearchHighlights();
        return;
      }

      const ranges = collectWindowSearchRanges(root, trimmed);
      rangesRef.current = ranges;
      setMatchCount(ranges.length);

      if (ranges.length === 0) {
        setActiveIndex(0);
        clearWindowSearchHighlights();
        return;
      }

      const nextIndex = options.resetIndex
        ? 0
        : Math.max(0, Math.min(activeIndexRef.current, ranges.length - 1));
      setActiveIndex(nextIndex);
      applyWindowSearchHighlights(ranges, nextIndex);
      if (options.scrollToActive) {
        scrollWindowSearchRangeIntoView(ranges[nextIndex]);
      }
    },
    [contentRef],
  );

  useEffect(() => {
    refreshMatches(query, { resetIndex: true, scrollToActive: true });
  }, [query, refreshMatches]);

  useEffect(() => {
    const root = resolveSearchRoot(contentRef);
    if (!root || !query.trim() || typeof MutationObserver === "undefined") {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        refreshMatches(query, { resetIndex: false, scrollToActive: false });
      }, MUTATION_DEBOUNCE_MS);
    });

    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [contentRef, query, refreshMatches]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f";
      if (!isFindShortcut) return;
      event.preventDefault();
      inputRef.current?.focus();
      const text = inputRef.current?.getText() ?? "";
      if (text.length > 0) {
        inputRef.current?.setSelection({ start: 0, end: text.length });
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const stepMatch = useCallback((delta: 1 | -1) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const nextIndex = stepSearchMatchIndex(activeIndexRef.current, delta, ranges.length);
    setActiveIndex(nextIndex);
    applyWindowSearchHighlights(ranges, nextIndex);
    scrollWindowSearchRangeIntoView(ranges[nextIndex]);
  }, []);

  const handleNext = useCallback(() => stepMatch(1), [stepMatch]);
  const handlePrev = useCallback(() => stepMatch(-1), [stepMatch]);

  const handleClear = useCallback(() => {
    inputRef.current?.replaceText("");
    setQuery("");
    rangesRef.current = [];
    setMatchCount(0);
    setActiveIndex(0);
    clearWindowSearchHighlights();
  }, []);

  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);

  const handleInputKeyPress = useCallback(
    (event: { nativeEvent: { key: string; shiftKey?: boolean } }) => {
      const { key, shiftKey } = event.nativeEvent;
      if (key === "Enter") {
        stepMatch(shiftKey ? -1 : 1);
      } else if (key === "Escape") {
        if (query.length > 0) {
          handleClear();
        } else {
          inputRef.current?.blur();
        }
      }
    },
    [handleClear, query.length, stepMatch],
  );

  const hasQuery = query.trim().length > 0;
  const matchLabel = useMemo(() => {
    if (!hasQuery) return "";
    if (matchCount === 0) return "0";
    return `${activeIndex + 1}/${matchCount}`;
  }, [activeIndex, hasQuery, matchCount]);

  return (
    <View
      dataSet={WINDOW_SEARCH_BAR_DATASET}
      style={[
        styles.searchField,
        (isFocused || hasQuery) && styles.searchFieldActive,
        isFocused && styles.searchFieldFocused,
        noDragStyle,
      ]}
    >
      <ThemedSearch size={13} uniProps={mutedColorMapping} />
      <ThemedTextInput
        ref={inputRef}
        testID="window-search-input"
        initialValue={query}
        onChangeText={setQuery}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyPress={handleInputKeyPress}
        accessibilityLabel="Filter and highlight text"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.input}
      />
      {hasQuery ? (
        <WindowSearchControls
          matchCount={matchCount}
          matchLabel={matchLabel}
          onPrev={handlePrev}
          onNext={handleNext}
          onClear={handleClear}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    width: 132,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  searchFieldActive: {
    width: 220,
  },
  searchFieldFocused: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 20,
    outlineWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  countText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginRight: 2,
  },
  countTextEmpty: {
    color: theme.colors.foregroundExtraMuted,
  },
}));
