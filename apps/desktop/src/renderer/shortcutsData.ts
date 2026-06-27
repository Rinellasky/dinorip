// Single source of truth for the keyboard & mouse shortcuts, shared by the
// in-app Shortcuts overlay and the README generator
// (scripts/generate-readme-shortcuts.mjs). Edit shortcuts.data.json — never the
// README's Shortcuts section by hand; it is regenerated from that file.
import shortcutsData from "./shortcuts.data.json";

// A key combo is a list of tokens chained with "+". The literal "mod" token is
// rendered as the platform modifier (⌘ / Ctrl). A shortcut can list several
// combos as alternatives (shown joined by "or"). Tokens that read as prose
// (e.g. "Drag a corner handle") are gestures rather than keys.
export type KeyCombo = string[];

export interface ShortcutEntry {
  action: string;
  keys: KeyCombo[];
  /**
   * GIF filename under assets/shortcuts/ for shortcuts worth demonstrating
   * (gestures, drags). Omitted for pure key presses that the keycaps already
   * explain — those show no demo at all.
   */
  gif?: string;
}

export interface ShortcutSection {
  id: string;
  title: string;
  /** Optional caveat shown under the section. */
  note?: string;
  shortcuts: ShortcutEntry[];
}

export interface ShortcutsDoc {
  /** Intro blurb shown above the sections. */
  intro?: string;
  sections: ShortcutSection[];
}

export const SHORTCUTS = shortcutsData as ShortcutsDoc;

// Eagerly bundle whatever demo GIFs exist under assets/shortcuts/ as URLs. The
// folder may be empty (clips are recorded later); a missing GIF simply has no
// entry here, and the overlay shows an empty placeholder in its place.
const gifModules = import.meta.glob("../../../../assets/shortcuts/*.gif", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

const gifUrlByName = new Map<string, string>(
  Object.entries(gifModules).map(([path, url]) => [path.split("/").pop() as string, url])
);

/** URL of a recorded demo GIF, or undefined while it has not been recorded yet. */
export function gifUrl(name: string): string | undefined {
  return gifUrlByName.get(name);
}
