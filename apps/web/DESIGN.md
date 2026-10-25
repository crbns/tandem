---
name: Tandem
description: Shared files for people. Shared understanding for their AI assistants.
colors:
  primary: "#b4321f"
  primary-foreground: "#ffffff"
  background: "#f3f4f2"
  foreground: "#1c2226"
  card: "#ffffff"
  muted: "#eceeed"
  muted-foreground: "#5d6870"
  border: "#d9ddda"
  input: "#c9cfcc"
  archive: "#3b4f5c"
  archive-tint: "#e8edf0"
  agent: "#2f7a6d"
  human: "#2b5a8a"
  unknown: "#a7b0b5"
  destructive: "#9e2b1b"
  warn: "#7a5410"
  warn-tint: "#f7f0df"
  warn-rule: "#e2cf9e"
  diff-left: "#f5ecd6"
  diff-right: "#dfe7ec"
typography:
  headline:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "2rem"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: "1.5rem"
  body:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "\"tnum\" 1"
  body-sm:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  label:
    fontFamily: "Archivo Narrow, Public Sans, ui-sans-serif, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  sm: "2px"
  md: "4px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-primary-disabled:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.archive-tint}"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.archive-tint}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "20px"
  register-head:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    padding: "0 16px"
    height: "40px"
  register-row-selected:
    backgroundColor: "{colors.archive-tint}"
  version-tag:
    backgroundColor: "{colors.archive-tint}"
    textColor: "{colors.archive}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  nav-item-active:
    backgroundColor: "{colors.archive-tint}"
    textColor: "{colors.archive}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  custody-mark-agent:
    backgroundColor: "{colors.agent}"
    size: "8px"
  custody-mark-human:
    backgroundColor: "{colors.human}"
    rounded: "{rounded.full}"
    size: "8px"
  custody-mark-head:
    size: "12px"
  alert-warning:
    backgroundColor: "{colors.warn-tint}"
    textColor: "{colors.warn}"
    padding: "12px 16px"
---

# Design System: Tandem

## Overview

**Creative North Star: "The Provenance Record"**

Every file in Tandem is handled like an archived object that carries its own chain of custody. The dashboard reads as an accession register rather than a SaaS file list. It sits on a cool acid-free grey board, with white paper panels drawn in 1px rules and ink-dark text. Condensed catalogue caps are used for accession numbers, version tags and column heads. Identity is the system's main subject. Each save is marked by who held the file, an assistant or a person, and that mark keeps the same shape and colour wherever it appears.

The surface is dense, quiet and daylight-legible: 14px body on a 20px line, tabular numerals everywhere, flat panels and almost no decoration. Colour is scarce and always means something. Slate gives structure and selection, verdigris marks agents, ink-blue marks humans, ochre marks unsaved or contested work, and accession red appears only on things you can press. There are two authored motions: the custody record sliding into place when you select a file, and a row an assistant just saved taking the agent tint before fading back.

The build rejects the neutral SaaS file table with pill badges: actor identity is a fixed mark plus a catalogue label, never a coloured lozenge.

**Key Characteristics:**
- Cool grey board, white paper panels, 1px rules, 4px corners.
- Two custody identities: verdigris squares for agents, ink-blue circles for humans; hollow squares for unrecorded versions.
- Archivo Narrow caps for codes, versions and column heads; Public Sans for everything else.
- Accession red reserved for pressable primary actions.
- Flat at rest; shadow only on floating layers.
- Two motions: the custody record's 180ms slide-in, and the arrival fade (a row an assistant just created or saved holds the agent tint and a 3px verdigris rule, then fades out over 8s, with a toast like "Alex via Claude created proposal.md").

## Colors

A cool, nearly achromatic archive palette with one slate structure colour, two identity hues, an ochre caution and a single red for action.

### Primary
- **Accession Red** (primary): the primary button ("New file", "Open file", "Save") and the link variant. Disabled primary buttons drop the red entirely and fall back to muted grey, because red means "you can press this".

### Secondary
- **Archive Slate** (archive): the Tandem mark, the "Current" label, active nav text, version-tag text, the focus ring and the text caret. Structure, not emphasis.
- **Archive Slate Tint** (archive-tint): selected register rows, the active rail item, the selected revision, version-tag fill, and hover on outline/ghost buttons. It is also the `accent` and `ring` alias family.

### Tertiary: custody identities
- **Verdigris** (agent): agent marks (squares) and the AGENT catalogue label.
- **Ink Blue** (human): human marks (circles), the HUMAN catalogue label and the user's avatar disc.
- **Unrecorded Grey** (unknown): the 1px outline of hollow-square marks for earlier versions whose holder wasn't recorded.

### Status
- **Ochre** (warn), **Ochre Wash** (warn-tint), **Ochre Rule** (warn-rule): the "Unsaved changes" state, the version-conflict alert and the "Saving will replace version N" disclosure. It clashes with neither identity hue nor the red.
- **Deep Accession Red** (destructive): destructive buttons inside confirmation dialogs, and the "Conflict" / "Not saved" save states.
- **Diff Ochre** (diff-left) and **Diff Slate** (diff-right): line bands for lines only on the left (your draft or the older version) and only on the right (theirs or the newer version). Each band also carries a − or + marker in the gutter.

### Neutral
- **Acid-free Board** (background): the page ground behind every panel.
- **Paper White** (card): panels, the register, the white left rail, the top bar, dialogs, toasts and inputs. Card, popover and sidebar all use this value.
- **Archival Ink** (foreground): all primary text.
- **Graphite** (muted-foreground): secondary text, timestamps, column heads, "via Claude" qualifiers.
- **Board Grey** (muted): disabled primary fill, diff column headers at 50%, segmented-control track. Same value as `secondary`.
- **Rule Grey** (border): every 1px panel, row and rail rule.
- **Field Grey** (input): input outlines.

### Named Rules
**The Red Means Press Rule.** Accession red appears only on things you can press: the primary button and the link. It never marks status, identity, headings or decoration, and a disabled button loses it.

**The Two Holders Rule.** Verdigris belongs to agents and ink-blue to humans, everywhere and for nothing else. The shape (square or circle) always carries the identity alongside the hue, so it reads without colour vision.

## Typography

**Display Font:** none. The largest type is the page headline.
**Body Font:** Public Sans (with ui-sans-serif, system-ui), weights 400–700, self-hosted via @fontsource.
**Label Font:** Archivo Narrow (with Public Sans), weights 500–600, set in caps.
**Mono Font:** Geist Mono (local variable font), for file content, diffs and drafts.

**Character:** a plain civic grotesque for reading and working, with a condensed catalogue face for the register's codes, like the typed labels on an archive box. Tabular numerals are on globally (`tnum`), so versions, counts and times line up.

### Hierarchy
- **Headline** (700, 24px, 32px line, -0.01em): page titles ("Files", the file name, "History: brief.md") and the sign-in wordmark.
- **Title** (600–700, 16px, 24px line): panel headings ("Custody record") and the goal statement. Dialog titles step to 18px/600.
- **Body** (400–600, 14px, 20px line, tabular): the working size for table cells, buttons, breadcrumbs and descriptions. File names in the register are 600.
- **Body Small** (400–500, 12px, 16–18px line): timestamps under custody entries, the rail's Assistants note, the diff legend.
- **Label** (Archivo Narrow 600, 12px, 16px line, 0.06em, uppercase): column heads, accession numbers (TDM-CB32), version tags (V2, EDITING FROM V1), CURRENT, and the AGENT / HUMAN plate.
- **Mono** (Geist Mono, 12px, 1.625 line): file content in diffs and draft previews.

### Named Rules
**The Catalogue Caps Rule.** Archivo Narrow caps label data: codes, versions, actor class and column heads. It is never set as an eyebrow or kicker above a heading, and never used for running text.

## Layout

The app shell is a fixed white left rail (232px, a 1px right rule, sticky full-height) beside a column with a 56px white top bar (breadcrumb on the left, account on the right) and a scrolling main area on the grey board (32px side padding and 28px top on desktop, 16px on mobile). The files view is capped at 1152px wide and stacks with 20px gaps: a heading row with the record count and actions, the approved-goal panel, the filter field (max 320px), then the register.

From 1280px up, the register and the custody record sit side by side in a `1fr / 20rem` grid with a 24px gap. Below 1280px the custody record is hidden and the register runs full width. Below 768px the rail disappears and the Tandem mark moves into the top bar. The register drops its No. column below 1280px and its Last held by column below 768px. Below 640px it also drops the Custody column, folding the custody strip and the identity plate into a second line under the file name, and a one-line agent/human legend appears above the filter. The history view puts the revision rail beside a two-column diff, which stacks below 1024px.

Spacing follows a 4px grid (4, 8, 12, 16, 20, 24, 32). Register cells are 16px × 14px, so a row is 48px plus its rule. Panels pad 20px. Inline clusters use 6px gaps between a mark, its label and the name.

## Elevation & Depth

Flat by default. Depth comes from tone and rule: white paper panels on the grey board, separated by 1px Rule Grey lines, with selection shown as a slate tint and no lift. Shadows exist only as Tailwind's soft ambient values: a hairline on controls and a real shadow on layers that float above the page.

### Shadow Vocabulary
- **Control hairline** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): buttons (except ghost) and inputs.
- **Floating toast** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): Sonner toasts, bottom right.
- **Dialog** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): confirmation dialogs, over a 40% black scrim.

### Named Rules
**The Paper On Board Rule.** Panels, the register and the custody record never cast shadows. They are set apart by white against grey and a 1px rule. Shadows are only for things that float: dialogs, toasts and menus.

## Shapes

Corners are barely softened at 4px on panels, buttons, inputs, rows and the active nav item, and 2px on inline version tags. The only round forms are identity forms: the human custody mark and the user's avatar disc. The agent mark is a hard square, and the unrecorded mark is a hollow square with a 1px outline. Chains of custody are drawn as a single 2px vertical rule, with each version's mark centred on it, newest at the top. The Tandem mark is two overlapping outlined rectangles in a 2px stroke: one file, two holders.

## Components

### Buttons
Compact and quiet; the red one is the only loud object on screen.
- **Shape:** gently squared (4px), 36px tall by default, 32px small; icon 16px with an 8px gap.
- **Primary:** Accession Red fill, white 14px/500 text; hover drops to 90% opacity. Disabled turns muted grey fill with graphite text and no shadow, so it carries no red.
- **Outline:** board-grey fill, 1px rule, hairline shadow; hover takes the slate tint. Used for "Refresh", "Full history", "Back to file" and both conflict choices. Neither conflict choice is styled as the default because both lose something.
- **Ghost:** no fill; hover takes the slate tint. Used for History, Discard changes and Copy in the save bar and diff headers.
- **Destructive:** deep red fill, used only as the confirming action inside a dialog.
- **Focus:** a 2px Archive Slate outline at a 2px offset globally; buttons and inputs add a 3px ring at 50% slate.

### Inputs / Fields
- **Style:** 36px tall, 1px Field Grey outline, 4px corners, white on the files page, 12px side padding (32px left when it carries a leading search icon).
- **Focus:** the border shifts to slate with a 3px 50% slate ring.
- **Error / Disabled:** the border turns destructive red on `aria-invalid`; disabled fades to 50%.

### Cards / Containers (paper panels)
- **Corner Style:** 4px.
- **Background:** Paper White on the Acid-free Board.
- **Shadow Strategy:** none (see The Paper On Board Rule).
- **Border:** a 1px Rule Grey line. An empty state uses a dashed rule (for example, no goal yet).
- **Internal Padding:** 20px. The goal card pads 20px × 16px, and the save bar pads 12px × 8px.

### Navigation
- **Rail:** a white 232px rail. The Tandem mark and workspace name (600) sit at the top, with "Tandem workspace" in graphite beneath. Five items follow: Overview, Files (with its count in catalogue caps), Project context, Assistants and Live. Below 768px the account menu carries all but Files. The Assistants note at the foot explains the agent and human marks inline. Active item: slate tint with slate text. Inactive item: ink text with the slate tint on hover.
- **Top bar:** a white 56px bar. Breadcrumb: workspace in graphite, a slash, the current section in 600. On the right are the account menu (an ink-blue initial disc plus the name) and, in mock mode, a dashed "MOCK DATA" caps badge.
- **In-page breadcrumb:** graphite links separated by 14px chevrons, with the current item in ink, above each file headline. An accession-number and type line in catalogue caps sits under the headline.

### The Register (signature)
The file table, styled as an accession register. Column heads use catalogue caps in graphite on a 40px row: No., Name, Custody, Last held by, Updated (right-aligned). Rows have a 1px rule and a 60% slate-tint hover. The selected or focused row takes the full slate tint. A click or focus selects a row, and a double click or Enter opens it. The No. column shows a stable accession code (TDM-XXXX) in caps. The name is 14px/600. Updated is a relative time in graphite, with the absolute time in the title attribute.

### Custody Mark and Custody Strip (signature)
- **Mark:** an 8px square (agent, verdigris), an 8px circle (human, ink-blue) or an 8px hollow square (unrecorded, 1px grey outline). The head or current version uses the 12px size.
- **Strip:** one mark per recent version in a row with 4px gaps, the head mark one size larger, then the version tag (V2) in catalogue caps. A screen-reader label states the agent and human counts.

### Identity Plate
Every actor appears in one fixed form: the mark, then the catalogue label (AGENT in verdigris or HUMAN in ink-blue), then the name in 500 ink. For agents the name is the person whose assistant it was, followed by "via {assistant}" in graphite ("Alex via Claude"); an agent write with no recorded person shows the assistant alone. The plate states attribution only and never presence.

### Custody Record Panel (signature)
A 20rem paper panel to the right of the register at 1280px and up. It shows the "Custody record" title, then the file name and accession code, then a vertical 2px rule with up to six versions, newest first. Each entry has a 12px mark on the rule, the version tag, CURRENT in slate on the head, the identity plate, and a 12px line ("Saved via MCP" or "Saved in the dashboard" plus a relative time). The panel ends with Open file (primary) and Full history (outline). It enters with the custody-in motion: 180ms, `cubic-bezier(0.16, 1, 0.3, 1)`, from opacity 0 and 4px below. The motion is disabled under reduced-motion.

### Save Bar
A white strip with a 4px radius that sits above the editor. From left to right it holds: a slate version tag ("VERSION 2", or "EDITING FROM V1" while dirty), a live state with an icon (Saved in graphite, Unsaved changes in ochre, Conflict or Not saved in deep red, Saving with a spinning loader), and "Last edited by" with the identity plate. On the right sit History (ghost), Discard changes (ghost) and Save (primary).

### Revision Rail and Diff
The history list uses the same 2px rule as the custody record. Each version is a full-width 4px-radius button; the selected version takes the slate tint and the others take a 70% tint on hover. The diff is two bordered columns with muted header strips (44px minimum, so both columns' first lines align) and 12px mono content. Changed lines use Diff Ochre or Diff Slate bands plus a −/+ gutter marker, and a one-line legend sits beneath. A segmented control (Changes in this version / Rendered / Raw) switches the view.

### Alerts and Toasts
The conflict alert is an ochre wash with an ochre rule and ochre text, a 16px icon, a title at 500 and a description at 90% opacity. Toasts are white with a 4px radius and a 1px rule. Their success icon is slate and their error icon is deep red.

## Do's and Don'ts

### Do:
- **Do** put Accession Red only on pressable primary actions, and strip it from disabled ones.
- **Do** show every actor through the identity plate: mark, AGENT/HUMAN catalogue label, name, and "{person} via {assistant}" for agents.
- **Do** keep custody marks at fixed sizes: 8px for every version, 12px for the head.
- **Do** draw a chain of custody as one 2px vertical rule with marks centred on it, newest first.
- **Do** set codes, versions, column heads and actor class in Archivo Narrow 600 caps at 12px with 0.06em tracking.
- **Do** separate surfaces with white paper on the grey board and a 1px rule, at 4px corners.
- **Do** mark diffs with a −/+ gutter marker as well as the ochre or slate band.
- **Do** use ochre for unsaved and contested work, never red.

### Don't:
- **Don't** render actor identity as coloured pill badges or lozenges; the build replaced them with marks and catalogue labels.
- **Don't** use verdigris or ink-blue for anything except agent and human identity.
- **Don't** convey custody by colour alone; the square-versus-circle shape is required.
- **Don't** say "online" or show live presence dots; the plate is attribution, and times read "last edited" or "saved".
- **Don't** use catalogue caps as an eyebrow or kicker above headings.
- **Don't** add shadows to panels, the register or the custody record; shadows belong to dialogs, toasts and menus.
- **Don't** add motion beyond the custody-in slide, the arrival fade and functional spinners, and honour reduced-motion (the arrival holds its tint without fading).
