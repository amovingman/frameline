# Desktop background jobs and previews

Project media now runs local hashing, asset checks, clip thumbnails, lightweight proxies and timeline storyboards through a durable background queue. This completes the five Phase 4.3 roadmap items for the experimental desktop delivery. The optional self-hosted integrity worker remains a separate queue; these desktop previews are not uploaded or rendered by a managed service.

Choose and scan a regular FCPXML export, open **Project media**, and choose a local media file. Hashing and file checks can run without enabling previews. For thumbnails, proxies or a storyboard, enable preview generation for that project and confirm permission to generate derivatives. Select a job type and choose **Queue job**. A storyboard reads the selected export's referenced media rather than the separately chosen file.

The Apple media helper uses AVFoundation, AppKit and ImageIO on macOS 13 or later. Development checkouts build it with `npm run build:media`; `npm start` builds a missing helper on macOS. A macOS build machine needs Xcode command line tools. Distribution packaging builds a universal arm64/x86_64 helper and includes it in the application inputs, so recipients do not need a compiler. Hashing and byte checks remain available when rendering is unavailable. Signed installers remain a separate release gate.

## Supported outputs

| Job | Result |
| --- | --- |
| Hash file | Streamed full-content SHA-256 and byte length, computed outside the Electron main thread. |
| Check asset | Verified local-file readability and full-content identity, with native media inspection when available. |
| Clip thumbnail | A real PNG sampled from a still image or a selected source-video frame. Video frame sampling uses the media's observed frame rate. |
| Lightweight proxy | A real MP4 of the full source video, at most five minutes, with a 640 × 480 bounding box; still images produce a resized PNG. |
| Timeline storyboard | A PNG containing up to 24 picture clips in timeline order, sampled at each clip's source in-point. |

PNG/JPEG still images and MOV/MP4/M4V videos are supported where Apple's installed decoders can read them. Unsupported codecs, excessive dimensions/duration/output size, unavailable media, symlinks and nonlocal references are refused. Thumbnail frames are bounded to 0–4096. Images are bounded to 4 MiB and video derivatives to 50 MiB.

Storyboards accept an unambiguous flat FCPXML 1.10 primary picture spine with exact frame timing and local original-media references. Nested or connected clips, effects, retiming, transitions, overlapping picture clips and ambiguous resources are refused. Gaps affect ordering; they do not become picture samples. The result is a storyboard, not an effects/audio render or a lossless editor preview. Original media and the selected export are checked before publication; a changed source invalidates the job.

## Recovery and consent

The private app profile stores the job journal and private source registry separately from revisions and sync bases. Renderer state contains opaque identities and safe display names, never filesystem paths. The cache contains only optional, explicitly noncanonical derivatives. Neither originals nor canonical edit data are changed, and this workflow makes no network request.

A single local worker serializes execution. Identical inputs reuse the same job identity. Progress, attempts, elapsed processing time and safe errors remain observable. Cancel aborts active work. Retry keeps the same inputs with a bounded attempt budget; Restart begins a new run. After the process stops, interrupted or queued jobs become paused and require **Resume** after reselecting the matching export. Launching the app never silently generates previews. Changing the selected project/export or revoking permission fences late publication. Jobs with superseded inputs or permission cannot be reused; queue a new job for the current selection.

Cache publication is exclusive and guarded. Viewing or revealing a derivative verifies its full hash and current project/permission scope again. Corrupt or replaced output is withheld; restart the job to produce a new result. Owned interrupted staging is cleaned using exact ownership markers. Uncertain files are preserved rather than blindly deleted. A journal write failure pauses work and blocks new jobs until the app is reopened after storage is repaired. An unreadable job journal leaves project scanning and saved history available.

## Monitoring

The panel reports backlog, running/paused/completed counts, failures, processing milliseconds and measured cache bytes, including owned retained partial outputs. Job history is paged in groups of 20; the durable queue holds up to 1,000 jobs. Published cache bytes include retained outputs from previous runs and outputs no longer referenced by a job result. Storage cost starts as **unknown**. An optional project-specific USD/GiB/month rate produces an explicitly labeled estimate from measured bytes. This is not a billing integration or a claim about cloud charges.

The final delivery passed all **1,539** full-suite tests with no failures or skips, universal-helper packaging, and the four-launch native proof. That proof verified 13 distinct requested video frames, an ordered three-clip storyboard, a real two-frame-decoded proxy, abrupt app-exit recovery, explicit resume, cache corruption refusal and isolation of a corrupt optional job journal. A separate idle-helper check killed its owned parent while another process held stdin open; the real helper exited in 23 ms. This does not claim an active-encoder kill test or production-scale performance evidence.

Run `npm run test:media-jobs` for focused controller, parser, artifact and native-provider contract checks. `npm run verify:media-jobs` runs the shipped Electron application across disposable profiles with generated real media and the actual native helper. Its retained evidence lives in [phase-0/media-jobs-desktop](phase-0/media-jobs-desktop). Full-suite tests and `npm run package:check` remain required before publication.
