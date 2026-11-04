# Journey

## Job
An editor needs to see what an incoming revision changes in an existing cut, understand conflicts, and choose how a future pull would write the result.

## Workspace flow
1. Open Launch film and see the sample revision pair, v0.3 to v0.4.
2. Read the finding: one trim conflict among three incoming changes.
3. Select a change from the queue or the sequence itself. The illustrative contact sheet locates the affected clip or audio lane.
4. Compare the common base, local cut, and incoming values.
5. Choose **Create review copy** or **Apply in place**. The latter will require a restore point.
6. When a supported adapter and conflict resolution exist, validate and perform the pull.

## Other views
- History: ordered sample revisions and their status.
- Media: assets referenced by the sample cut and their placeholder availability.

## Prototype truth
All revision, timeline, and media data comes from `src/sample-data.js`. A file picker can select a candidate file, but the app cannot parse or merge it. The pull action stays disabled and explains why.
