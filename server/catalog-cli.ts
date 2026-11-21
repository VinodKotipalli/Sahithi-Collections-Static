import fs from 'node:fs';
import path from 'node:path';
import {
  createCatalogBackup,
  evaluateCutoverReadiness,
  executeCatalogCutover,
  importCatalogDrafts,
  loadCatalogManifest,
  rollbackCatalogFromBackup,
  verifyActiveCatalog,
  type CatalogBackupSnapshot,
} from './catalog-cutover.ts';
import { createRuntimeStore } from './runtime-store.ts';

function parseArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'readiness';
  const manifestPath =
    parseArgValue(args, '--manifest') ||
    path.resolve(process.cwd(), 'data/catalog-20261121-drafts.json');
  const backupDir =
    parseArgValue(args, '--backup-dir') || path.resolve(process.cwd(), 'data/backups');

  const manifest = loadCatalogManifest(manifestPath);
  const { store } = await createRuntimeStore({
    seedCatalog: true,
  });

  try {
    console.log(
      `[catalog-cli] command=${command} backend=${store.backend} env=${store.targetEnv} location=${store.locationLabel}`
    );

    if (command === 'import-drafts') {
      const result = await importCatalogDrafts(store, manifest, {
        actorUserId: 'cli-catalog-importer',
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'readiness') {
      const readiness = await evaluateCutoverReadiness(store, manifest);
      console.log(JSON.stringify(readiness, null, 2));
      if (!readiness.ready) {
        process.exitCode = 2;
      }
      return;
    }

    if (command === 'backup') {
      const result = await createCatalogBackup(store, {
        batchId: manifest.batchId,
        backupDir,
      });
      console.log(
        JSON.stringify(
          {
            backupId: result.backup.id,
            backupPath: result.backupPath,
            productsCount: result.backup.products.length,
            categoriesCount: result.backup.categories.length,
            ordersAtBackup: result.backup.orderIdsAtBackup.length,
          },
          null,
          2
        )
      );
      return;
    }

    if (command === 'cutover') {
      const result = await executeCatalogCutover(store, manifest, {
        actorUserId: 'cli-catalog-cutover',
        backupDir,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        process.exitCode = 2;
      }
      return;
    }

    if (command === 'verify') {
      const result = await verifyActiveCatalog(store, manifest);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'rollback') {
      const backupFile = parseArgValue(args, '--backup') || args[1];
      if (!backupFile) {
        throw new Error('Usage: tsx server/catalog-cli.ts rollback --backup <path-to-backup.json>');
      }
      const raw = fs.readFileSync(path.resolve(backupFile), 'utf8');
      const snapshot = JSON.parse(raw) as CatalogBackupSnapshot;
      const result = await rollbackCatalogFromBackup(store, snapshot, {
        actorUserId: 'cli-catalog-rollback',
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    throw new Error(
      `Unknown command "${command}". Supported: import-drafts | readiness | backup | cutover | verify | rollback`
    );
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('[catalog-cli] Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
