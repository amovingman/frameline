# Frameline visual direction

The original Taste Skill app-screen deal (`framed-sheet`, seed `1781998590`) produced a quiet editor surface. It preserved the workflow but did not carry the expressive language of the supplied sample pages. The revised direction treats their imagery, condensed typography, sharp color fields, and editorial scale as the visual references, then applies them to the existing product task.

## Contact-sheet idea

The affected sequence is the hero image and the working object. A three-frame illustrative storyboard makes the changed clip visible. The exact clip, change type, conflict state, and three-way values remain adjacent, so the look serves review rather than becoming a marketing page. The frame imagery is generated sample material and explicitly labelled as such.

## Reference translations

- `coffee-storefront.webp`: very large condensed title, black/cyan contrast, simple hard-edged navigation.
- `coffee-roast.webp`: large image-led steps and editorial spacing.
- `coffee-questions.webp`: flat pink and lime fields to distinguish states without decorative borders.
- `night-dates.webp`: photographic grid, compact black labels, confident typography.

## Product constraints

The sample cut has local v0.3, incoming v0.4, three changes, and one trim conflict. Queue and frames select the same change. History and Media remain separate views. The two future pull destinations are review copy and in-place update. Parsing and pull are not implemented, so the file picker gives an honest notice and the pull action is disabled. Design tokens and behavior live in `DESIGN.md`, `src/styles.css`, and `src/renderer.js`.
