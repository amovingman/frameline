# Back up revision history to S3

Frameline can upload an exported revision bundle to a private Amazon S3 bucket, list the stored backups, and download a verified copy to a new local file. This is a small command-line feature for the portfolio. It does not need a running Frameline service.

Use Node.js 24 and the locked dependencies from `npm ci`. The current local checks ran on macOS and use POSIX file permissions and directory syncing. Windows CLI and demo behavior have not been validated. No Resolve installation or Swift helper is needed for these commands.

The backup contains saved revision metadata, branch heads, and supported observations. It does not contain camera footage, proxies, native Resolve databases, or runnable recovery commands. Downloading a backup does not import history or change an editor project. Use the desktop's existing **Import backup** flow when you want to review and import a downloaded bundle.

## Try it without an AWS account

After [installing dependencies](SETUP.md), run:

```sh
npm run demo:cloud-backup
```

The demo creates two real revisions with the production scanner and history store, exports their bundle, then exercises the production backup code against simulated in-memory storage. It checks upload, an identical retry, listing, and an exact-byte download. All temporary files are removed afterward. No cloud request is made, no credentials are read, and this run does not prove a live AWS deployment.

## Connect your own bucket

Create a private, general-purpose S3 bucket in a commercial AWS region, such as `us-east-1`. Keep S3 Block Public Access enabled. The app neither creates a bucket nor changes its policy. Use a bucket name with lowercase letters, numbers, and hyphens; this portfolio feature does not accept dotted names, access-point ARNs, directory buckets, GovCloud or China regions, or custom S3 endpoints.

Give the AWS identity access to only this bucket's backup prefix. The required actions are `s3:ListBucket` on the bucket and `s3:GetObject` / `s3:PutObject` on `frameline-backups/v1/*`. S3 defines separate bucket and object resources for these actions. [AWS permission reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_s3.html).

For example, replace `YOUR-BUCKET` in this identity policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR-BUCKET",
      "Condition": {
        "StringEquals": { "s3:prefix": "frameline-backups/v1/" }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/frameline-backups/v1/*"
    }
  ]
}
```

No delete permission is required. A bucket with customer-managed KMS encryption may require additional key permissions; the simple example above covers S3 permissions only. Bucket creation and account configuration are manual. Cloud usage can incur your provider's charges.

The AWS SDK uses its normal Node.js credential chain, including a configured profile or environment credentials. A profile can be selected with `AWS_PROFILE`. Keep credentials in your normal AWS setup; Frameline does not take access keys in command arguments or store them in its configuration. [AWS credential setup](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

If your AWS profile starts an external credential helper, that helper controls its own process lifetime. Frameline can cancel its request but cannot terminate a hung helper. Confirm that your AWS credential setup works before starting a backup.

Create a local JSON file outside the repository:

```json
{
  "version": 1,
  "provider": "aws-s3",
  "region": "us-east-1",
  "bucket": "your-private-bucket"
}
```

Restrict the file to your user before running a network command:

```sh
chmod 600 /absolute/private/cloud-backup.json
```

## Inspect, upload, and download

First save an export from the desktop's **Export backup** button. For Resolve observation history, use **Review backup export**. Keep the export outside this repository.

Inspect the exact file you plan to upload:

```sh
npm run cloud:backup -- inspect --file /absolute/frameline-revisions.json
```

Inspect returns a SHA-256 and a bounded metadata summary. Read the JSON file too if you need to check revision messages or other exported text. Upload requires the hash from that inspection, so a changed local file cannot silently replace the reviewed bytes:

```sh
npm run cloud:backup -- upload \
  --config /absolute/private/cloud-backup.json \
  --file /absolute/frameline-revisions.json \
  --sha256 REPLACE_WITH_REVIEWED_SHA256
```

List one page of backups:

```sh
npm run cloud:backup -- list --config /absolute/private/cloud-backup.json
```

If the result supplies a `continuationToken`, pass it unchanged through `--cursor` to request the next page. A listing reports object identities and sizes; it does not download and verify every backup.

Download an identified backup to a new filename:

```sh
npm run cloud:backup -- download \
  --config /absolute/private/cloud-backup.json \
  --sha256 REPLACE_WITH_BACKUP_SHA256 \
  --destination /absolute/downloaded-frameline-revisions.json
```

The command checks the downloaded bytes against the requested SHA-256 and validates the revision bundle before publishing the file. An existing destination is preserved, including a symlink. The downloaded file has private permissions and is ready for a separate local import review.

## What the feature guarantees

The object key is derived from the complete bundle's SHA-256: `frameline-backups/v1/<sha256>.json`. Upload uses S3's conditional create request, `If-None-Match: *`. If the key already exists, Frameline reads it and accepts the retry only when the bytes match. It does not replace a different object. [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

Backups are limited to **10 MiB**, **1,000 revision records**, and **100 branches**. Unsupported data, malformed ancestry, unknown envelope fields, changed source bytes, and hash mismatches are refused. HTTPS protects the transfer. The bundle is JSON metadata and has no client-side encryption; revision messages and supported observation fields remain readable to identities that can read the object. Choose synthetic portfolio data for the demo and review your export before uploading it.

Cloud backup is explicit and manual. There is no background sync, scheduled backup, media upload, retention cleanup, delete command, or automatic restore. A cancelled or timed-out upload may have reached S3 even if its response was lost; retry the same reviewed file and hash to check that object.

Download publishes only a fully checked new local file. If it reports `cloud-backup-save-uncertain`, or is interrupted near completion, inspect the chosen destination before choosing another filename. An existing file is never replaced on retry. The content hash detects changes; it does not authenticate who authored a bundle.

## Verification

Run the focused tests with `npm run test:cloud-backup`. They cover the real revision-bundle validator, local filesystem behavior, and AWS SDK command construction. A local HTTPS protocol fixture also exercises the CLI with the real AWS SDK: signed requests, verified TLS, conditional upload, identical retry, XML listing, exact-byte download, permission refusal, and corrupt-object refusal. It uses public test certificates and synthetic credentials, with no AWS request. The account-free demo composes the production backup core with simulated storage.

These checks do not claim that an AWS account was connected or a real bucket was exercised. To check your own setup, upload one synthetic export and download it to a fresh filename, then compare its SHA-256 with the inspected value.
