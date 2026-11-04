# Getting started

This folder contains the initial Electron desktop shell for the Git for Video Editing project. The product design and scope are in [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).

## Requirements

- Node.js (the workspace was checked with Node 24.21.0 and npm 11.19.0)
- npm

## Install and run

From this folder:

```sh
npm install
npm start
```

The first command downloads the Electron development dependency and creates `package-lock.json`. The second opens the desktop prototype.

## Current starter structure

- `src/main.js`: Electron main process and desktop window
- `src/preload.js`: restricted bridge for future desktop APIs
- `src/index.html`, `src/styles.css`, `src/renderer.js`: starter interface
- `SYSTEM_DESIGN.md`: product system design

## First product milestone

Choose one video editor, then build a local proof of concept that reads a real project, creates a structured manifest, displays a diff, and applies one incoming edit to a copy while preserving unrelated local edits. Keep the original project untouched until the adapter has been validated.

## macOS launch note

If `npm start` exits immediately with `SIGABRT` while launched from a restricted or sandboxed shell, the failure may occur while macOS registers the Electron GUI process, before the app code runs. Launch from the macOS Terminal app in this folder instead:

```sh
cd "/Users/user/Downloads/Work Projects/Git for Video Editing"
npm start
```

## UI prototype

The app now shows a sample project workspace with a sequence preview, change list, history, media, and the two pull mode choices. The revision and media entries are labeled sample data. Choosing a project file opens the system file picker and shows its name; parsing and pulling still require an editor adapter.

The design process artifacts are in `JOURNEY.md`, `DESIGN.md`, and `.design-foundations/`. A static mock is in `mocks/workspace.html`.
