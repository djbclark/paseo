import { useQuery } from "@tanstack/react-query";
import {
  usePaseo,
  useSettings,
  type PluginIdentityColor,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  ColorSwatch,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { COLORS, colorSettings } from "../shared/colors";
import { labelKey } from "../shared/resolve";

type Colors = Extract<SettingsState<typeof colorSettings.schema>, { status: "ready" }>;

const rowStyle = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
const SWATCH_SIZE = 24;

function SwatchChoice({
  color,
  selected,
  onSelect,
}: {
  color: PluginIdentityColor;
  selected: boolean;
  onSelect(color: PluginIdentityColor): void;
}) {
  const select = useCallback(() => onSelect(color), [onSelect, color]);
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={color}
      accessibilityState={state}
      onPress={select}
    >
      <ColorSwatch color={color} selected={selected} size={SWATCH_SIZE} />
    </Pressable>
  );
}

function SwatchPicker({
  value,
  onSelect,
}: {
  value?: PluginIdentityColor;
  onSelect(color: PluginIdentityColor): void;
}) {
  return (
    <View style={rowStyle}>
      {COLORS.map((color) => (
        <SwatchChoice key={color} color={color} selected={color === value} onSelect={onSelect} />
      ))}
    </View>
  );
}

function RuleRow({
  index,
  label,
  color,
  settings,
}: {
  index: number;
  label: string;
  color: PluginIdentityColor;
  settings: Colors;
}) {
  const remove = useCallback(() => {
    const labelRules = settings.values.labelRules.filter((_, at) => at !== index);
    void settings.save({ ...settings.values, labelRules }, settings.revision);
  }, [settings, index]);
  return (
    <SettingsRow label={label}>
      <View style={rowStyle}>
        <ColorSwatch color={color} size={SWATCH_SIZE} />
        <SettingsAction
          label={`Remove the rule for ${label}`}
          actionLabel="Remove"
          disabled={settings.saving}
          onPress={remove}
        />
      </View>
    </SettingsRow>
  );
}

function NewRule({ settings }: { settings: Colors }) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<PluginIdentityColor>(COLORS[0]);
  const [generation, setGeneration] = useState(0);
  const add = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // One rule per label: adding an existing label recolors it.
    const rest = settings.values.labelRules.filter(
      (rule) => labelKey(rule.label) !== labelKey(trimmed),
    );
    const labelRules = [...rest, { label: trimmed, color }];
    if (await settings.save({ ...settings.values, labelRules }, settings.revision)) {
      setLabel("");
      setGeneration((value) => value + 1);
    }
  }, [label, color, settings]);
  return (
    <SettingsCard>
      <SettingsInput
        key={generation}
        label="Label"
        placeholder="Workspace label"
        onChangeText={setLabel}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsRow label="Color">
        <SwatchPicker value={color} onSelect={setColor} />
      </SettingsRow>
      <SettingsAction
        label="Colors every workspace with this label"
        actionLabel="Add rule"
        disabled={settings.saving || label.trim() === ""}
        onPress={add}
      />
    </SettingsCard>
  );
}

function OverrideRow({
  name,
  color,
  settings,
  scope,
  id,
}: {
  name: string;
  color: PluginIdentityColor;
  settings: Colors;
  scope: "workspaces" | "projects";
  id: string;
}) {
  const clear = useCallback(() => {
    const { [id]: _removed, ...rest } = settings.values[scope];
    void settings.save({ ...settings.values, [scope]: rest }, settings.revision);
  }, [settings, scope, id]);
  return (
    <SettingsRow label={name}>
      <View style={rowStyle}>
        <ColorSwatch color={color} size={SWATCH_SIZE} />
        <SettingsAction
          label={`Clear the color for ${name}`}
          actionLabel="Clear"
          disabled={settings.saving}
          onPress={clear}
        />
      </View>
    </SettingsRow>
  );
}

function ColorControls({
  settings,
  theme,
}: {
  settings: Colors;
  theme: PluginSurfaceProps["theme"];
}) {
  const paseo = usePaseo();
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const { data } = useQuery({
    queryKey: ["workspace-colors", "names"],
    queryFn: async () => {
      const { entries } = await paseo.workspaces.list();
      return {
        workspaces: new Map(entries.map((entry) => [entry.id, entry.name])),
        projects: new Map(entries.map((entry) => [entry.projectId, entry.projectDisplayName])),
      };
    },
  });
  const { workspaces, projects, labelRules } = settings.values;
  return (
    <>
      <Text style={style}>
        Two projects can share a color; pick one here to tell them apart. Colors apply to the
        workspace header and tab row.
      </Text>
      <SettingsSection title="Label rules">
        {labelRules.length > 0 ? (
          <SettingsCard>
            {labelRules.map((rule, index) => (
              <RuleRow
                key={labelKey(rule.label)}
                index={index}
                label={rule.label}
                color={rule.color}
                settings={settings}
              />
            ))}
          </SettingsCard>
        ) : null}
        <NewRule settings={settings} />
      </SettingsSection>
      <SettingsSection title="Overrides">
        <SettingsCard>
          {Object.entries(workspaces).map(([id, color]) => (
            <OverrideRow
              key={`workspace:${id}`}
              scope="workspaces"
              id={id}
              name={data?.workspaces.get(id) ?? id}
              color={color}
              settings={settings}
            />
          ))}
          {Object.entries(projects).map(([id, color]) => (
            <OverrideRow
              key={`project:${id}`}
              scope="projects"
              id={id}
              name={data?.projects.get(id) ?? id}
              color={color}
              settings={settings}
            />
          ))}
          {Object.keys(workspaces).length + Object.keys(projects).length === 0 ? (
            <SettingsRow
              label="No overrides"
              hint="Use the palette button in a workspace header."
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function ColorSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(colorSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Workspace colors">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  return <ColorControls settings={settings} theme={theme} />;
}
