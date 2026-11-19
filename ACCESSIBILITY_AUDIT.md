# Desktop accessibility

This completes the dense timeline/conflict navigation item and the broader current-app accessibility audit. The two scopes are distinct: dense queues need reliable item navigation and source-aware focus recovery; the complete app needs named controls, reachable forms and disclosures, clear statuses, visible focus, reduced motion, and readable text across its workflows.

## Dense timeline and conflict review

Timeline clips, sample change queues, Resolve changes, and Resolve revision history are named groups of native buttons. Each group has a single tab stop. Arrow keys move within that group, Home/End reach its boundaries, and native Space/Enter activate the focused button. Button names include the item and its page position; Resolve names also include the matching/full range.

Stable public clip/change/revision anchors preserve focus when a row is rebuilt after selection or a decision. Focus is restored only if the source fingerprints/project identity still match and focus fell back to the document body. Source changes and intentional focus elsewhere prevent restoration. Duplicate clip names do not identify an item. Paging and Next unresolved retain their explicit focus targets. Scrollable source values are keyboard-focusable and named by their source-role heading.

## Whole-app audit

A skip link reaches main content. Native controls retain their own semantics; decorative marks/waveforms are excluded from the accessibility tree. Status regions expose atomic polite updates, while disabled actions stay disabled. Focus uses the existing cyan outline; reduced-motion preferences remove transitions/animations. Placeholder and breadcrumb text use the approved readable muted token.

The native audit exercises onboarding, diagnostics privacy review, all four primary views in sample and selected-file states, saved local history, Resolve conflicts, paging, and refreshed sources. It also checks retained conditional native controls for associated names rather than assuming hidden controls are valid. The shipped app/preload/main process is used, with disposable source files and fixture-supplied OS picker results.

The recorded pass includes **781 accessibility-tree control checks**, **296 retained-control name checks**, and **2,070 computed text-contrast checks** across 13 states, with no unnamed controls or failing checked text. Contrast uses the applicable normal/large-text thresholds; disabled/inactive controls retain their native exemptions. Trusted keyboard events verify navigation, activation, duplicate-name selection, decision/paging focus, and stale-source refusal. Layout checks cover 360, 390, 768, and 1440 CSS pixels without horizontal overflow.

This is a Chromium accessibility-tree, native-keyboard, focus, and contrast audit. It does not claim VoiceOver speech testing or formal accessibility certification. The evidence is [phase-0/accessibility-desktop/verification.json](phase-0/accessibility-desktop/verification.json); rerun with `npm run verify:accessibility`.

## Copy-recovery controls

The additional crash-recovery panel uses named native disclosures/buttons, a live count/range, server-side 20-entry paging, source-independent opaque transaction IDs, and unique ordinal reveal labels. Page changes focus the updated range. Its separate native proof checks 20 unique reveal names in the actual accessibility tree, safe reveal, restart recovery, and the same desktop/narrow layout sizes. See [copy-recovery evidence](phase-0/copy-recovery-desktop/verification.json).
