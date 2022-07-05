import path from 'node:path';
import { Level } from 'level';

import CONFIG from '../config.json' assert {type: "json"};

const assetDatabasePath = path.join(CONFIG.database.location, 'assets');
const assets = new Level(assetDatabasePath);

export {
  assets
};

export default async function init() {
  await assets.open();
}