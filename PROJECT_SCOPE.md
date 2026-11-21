# Project scope

Frameline is a résumé portfolio project: a GitHub repository that shows how a desktop app can track video-editing decisions, compare revisions, and recover safely from failure. The owner confirmed this scope on November 21, 2026. A reviewer should be able to understand the problem, see a short demo, and run the fixture workflow without a Resolve installation or cloud account.

## What the repository demonstrates

The completed prototype includes read-only FCPXML scanning, immutable local history and branches, three-way review, source-bound native checkpoints, verified backups, and recovery. It also contains self-hosted collaboration and media-transfer experiments. Those experiments remain available as engineering examples; running a hosted service is not part of the portfolio walkthrough.

The editor-backed evidence targets **DaVinci Resolve Free 21.1.2, build 21.1.20010, on macOS**. Native Apply is limited to one reviewed existing video clip Name in the supported closed local project profile. It requires the documented identity, backup, preservation, editor-validation, and recovery checks. General timeline merging, arbitrary native edits, and other editor versions are not supported. See [the compatibility guide](PERSONAL_COMPATIBILITY.md) and [safe Apply](SAFE_APPLY.md).

The required implementation roadmap is complete within those boundaries. The portfolio presents that work through a concise [README](README.md), a [fixture demo](DEMO.md), clear [setup instructions](SETUP.md), and checks a reviewer can run from a fresh checkout. Existing limitations stay visible rather than becoming new feature commitments.

## What completion does not require

Public installers, signing and notarization, automatic updates, release channels, managed hosting, paid infrastructure, usage research, additional editors, studio storage integrations, real-time co-editing, and cloud rendering are outside the required portfolio scope. The eleven former roadmap requirements are retained only as [future ideas](ROADMAP.md#future-ideas-outside-the-portfolio-scope). They have been removed from the required checklist, not marked as delivered. Existing code and historical evidence remain in the repository.

Use small, disposable synthetic projects for development and validation. Fresh fixture generation defaults to 50 clips. Customer projects, recruited testers, and further scale testing are unnecessary unless a specific change needs them. No credentials, personal media, or private native proof payloads belong in the public demo.

## Evidence and delivery

The [November 19 scope record](phase-0/project-scope.json) and [archived scope text](phase-0/evidence-sources/project-scope-observed-20261119.md.txt) preserve the earlier sole-owner decision used by the historical editor evidence audit. They are historical inputs; this document records the later portfolio purpose. Changing the presentation scope does not change an old observation or grant new editor write capabilities.

Commit verified work locally. Push to GitHub only when the owner explicitly requests it.
