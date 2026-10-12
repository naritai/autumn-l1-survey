import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, csv } from '../lib/store.mjs';
import { ROOT, catalog } from '../server.mjs';
const dataDir = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const store = new Store(dataDir, catalog);
const destination = resolve(process.argv[2] || join(dataDir, 'results.csv'));
writeFileSync(destination, csv(store.rows()), { mode: 0o600 }); store.close();
console.log(`CSV: ${destination}`);
