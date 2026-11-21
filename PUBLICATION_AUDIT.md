# Publication audit

The November 21, 2026 audit examined the completed portfolio tree at `3c5ddbf`, all fetched local and remote Git history, compressed evidence, and tracked images before publication.

## Checks and findings

- **Tracked files:** 1,476 files scanned from a separate tracked-only snapshot. Ignored local workspaces and credentials were excluded from the publication inputs.
- **History:** 293 reachable commits inspected across local and fetched remote refs; Gitleaks scanned 283 commits containing patches. No `.env`, AWS credential directory, private native proof payload, database, or journal signing-key file was found in reachable history.
- **Secret scanner:** official Gitleaks 8.30.1, downloaded from its release page and checked against its published SHA-256. Both current files and history were scanned with archive and decoding depth set to three.
- **Scanner findings:** each scan reported 2,138 candidates. Review classified them as 1,477 source or structural hashes, 658 synthetic/native object identifiers, one fixed synthetic test token, one shortened structural field identifier, and the deliberately public loopback TLS test key. No production API key, service credential, or private signing key was identified.
- **Images:** macOS text recognition processed all 84 tracked images. No credential or personal-email patterns were identified in that text; no GPS metadata was present.
- **GitHub contents:** the private repository had no releases, release assets, open issues, wiki, or Pages site at the time of inspection.

The TLS fixture's purpose is explained in [its README](tests/fixtures/network-tls/README.md). Raw scanner reports and recognized image text stay outside Git. Ordinary Git author metadata is separate from application credentials and remains visible when its history is published.

## Scope of the result

This is a point-in-time review, not a guarantee that every possible secret format can be detected. It does not inspect the owner's ignored runtime state, AWS credential files, or operating-system credential stores. Those are not publication inputs.

The implementation passed all 2,473 tests, package checks, and a production dependency audit before this publication review. A fresh public-file checkout has a separate validation path; private native editor evidence is intentionally unavailable there. See [setup](SETUP.md) and [the cloud backup guide](CLOUD_BACKUP.md).
