---
name: Frameline graphite review workspace
description: A calm editing workspace that connects sequence clips to incoming revision differences.
colors:
  ground: "#141415"
  sidebar: "#101011"
  surface: "#1b1b1d"
  raised: "#27272a"
  text: "#ededee"
  secondary: "#b4b4ba"
  muted: "#96969e"
  cyan: "#9eeaf0"
  conflict: "#edb977"
  ready: "#a9c6b3"
typography:
  interface: IBM Plex Sans
---

## Approved direction

A graphite editing suite: calm, precise, focused. The user approved this direction on November 3, 2026. Mode: Operate. The screen answers “Which incoming edits affect my cut, and where do they differ?”

The sequence is the visual anchor. Selecting an affected clip, its audio track, or a queue row synchronizes the selected edit and the common base / local / incoming comparison. History and Media share the same shell and typography.

## System

- Self-hosted IBM Plex Sans, weights 400–600. Page titles 24–28px, sections 15px, body 13–14px, metadata 12px. Tabular numerals for revisions and timecodes.
- Graphite surfaces with subtle neutral separation; cyan identifies selected footage and incoming values. Amber means a conflicting edit; muted green means a ready edit. Status includes text.
- A 208px desktop sidebar holds product identity, workspace, navigation, and the file picker. At 800px it becomes top navigation. At 600px review panels stack in reading order and the storyboard scrolls horizontally.
- Consistent spacing on a 4px scale; 12px main panel radius and 6px controls. No shadows or decorative gradients. Quiet rules divide adjacent working areas.
- Visible cyan keyboard focus. 160ms control feedback and a short comparison transition, with reduced-motion support.

## Product truth

All sequence, media, and revision data are illustrative. Three online mountain photographs replace the generated artwork in Review and Media. They are downloaded locally and shown as sample footage, not extracted from a project. CSS cover crops keep them responsive. Sources and photographer credits are recorded in `src/assets/visuals/MOUNTAIN-CREDITS.md`.

The desktop file picker can select a file, but no adapter reads its content. Pull remains disabled. Review-copy and in-place options describe future behavior without modifying project files. Keyboard shortcuts Command/Control + 1, 2, and 3 switch views.

## Design sources

The main workflow follows [unslop by Damir Sokolovsky](https://github.com/heydamir/unslop), CC BY 4.0, installed at `.agents/skills/unslop`. Impeccable supplied hierarchy, accessibility, and interaction guidance. Taste's app-screen guidance supplied task-first density and restrained surfaces (true-black-flat draw, seed 1903709023), adapted to the approved graphite palette and existing Plex font.
