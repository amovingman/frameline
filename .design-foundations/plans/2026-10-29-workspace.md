# Plan: workspace UI

**Status:** complete
**Track:** Quick

## Context
Build a desktop editing workspace for revision review and two pull paths. User feedback on the first dark dashboard design called for expressive typography, unusual shapes and colors, and no bordered card system.

## Phase 1 — Journey and page structure
**Stage:** Discover
**Doctrine:** journey, usability, content-design
**Produces:** JOURNEY.md
**Done when:** An editor can scan project state, inspect timeline changes, switch among Overview, History, and Media, and see both pull modes. Sample data is clearly labeled.

## Phase 2 — Editorial production desk
**Stage:** Design
**Doctrine:** design-dna, surfaces, design-systems, ai-tells
**Depends on:** Phase 1
**Produces:** DESIGN.md, static mock, desktop UI
**Done when:** The timeline is the focal point; New York and Avenir Next Condensed create a recognizable type voice; status colors encode clip state; no decorative borders or repeated card grid remain; pull modes are distinct and operable; pull remains disabled until an editor adapter exists.

## Evidence
The Electron window was inspected after restart. The timeline, two pull modes, and project picker were visible. The static detector was run on the final HTML.
