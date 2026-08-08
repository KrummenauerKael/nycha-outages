/**
 * One real poll, from this machine. `pnpm ingest:once`
 *
 * This is how the first live collection is taken and how a deployment problem is
 * told apart from an ingest problem: it runs exactly the same `runIngest` the cron
 * route runs, with nothing between it and NYCHA.
 *
 * It DOES fetch the live page and DOES write to the archive. That is the point,
 * but it is not something to run in a loop — one GET, politely, per invocation.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from '@archive/db/client';
import { DuplicateIdentityError, IngestValidationError, runIngest } from '@archive/ingest';

const envFile = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const { db, client } = createDb();

try {
  const result = await runIngest({ db });

  console.log(`snapshot ${result.snapshotId}`);
  console.log(`  http ${result.httpStatus} in ${result.attempts} attempt(s)`);
  console.log(`  sha256 ${result.sha256.slice(0, 16)}…`);
  console.log(
    `  stored ${result.storedBytes ?? 'NOT UPLOADED'} bytes at ${result.storageKey ?? '-'}`,
  );
  console.log(`  retain until ${result.retainUntil?.toISOString() ?? 'indefinitely'}`);
  console.log(
    `  parsed ${result.parsedRows} rows, ${result.countRows} counts, ${result.summaryRows} summaries`,
  );

  const o = result.observations;
  if (o) {
    console.log(
      `  events +${o.eventsInserted} bumped ${o.eventsBumped} | ` +
        `versions +${o.versionsInserted} bumped ${o.versionsBumped} | ` +
        `absences ${o.absencesRecorded} | services ${o.serviceRows} children ${o.childRows}`,
    );
  } else {
    console.log('  observation timeline NOT written (snapshot failed validation)');
  }

  if (result.reviewCount > 0) {
    console.log(`  ${result.reviewCount} row(s) queued for review`);
  }
  for (const warning of result.warnings) {
    console.log(`  warning: ${warning}`);
  }
} catch (error) {
  if (error instanceof IngestValidationError) {
    console.error(`counts mismatch. Snapshot ${error.snapshotId} was committed and is retained.`);
    console.error(error.detail);
  } else if (error instanceof DuplicateIdentityError) {
    console.error(
      `identity collision. Snapshot ${error.snapshotId} was committed and is retained.`,
    );
    console.error(error.duplicates);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
