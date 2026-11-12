// Prepares a byte-identical review copy. No pull plan or editor edit is applied.
const { prepareReviewCopy } = require('../src/review-copy-preflight');

if (require.main === module) {
  const [sourcePath, destinationDirectory, preferredFilename, expectedSha256, ...extra] = process.argv.slice(2);
  if (extra.length || !sourcePath || !destinationDirectory || !preferredFilename || !expectedSha256) {
    process.stderr.write('usage\n'); process.exitCode = 1;
  } else {
    try {
      const reviewCopyPath = prepareReviewCopy({ sourcePath, destinationDirectory, preferredFilename, expectedSha256 });
      process.stdout.write(`${JSON.stringify({ reviewCopyPath, readOnlySource: true, planApplied: false }, null, 2)}\n`);
    } catch { process.stderr.write('review-copy-preflight-failed\n'); process.exitCode = 1; }
  }
}
