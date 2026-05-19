#!/usr/bin/env bun

import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageSchemaPath = fileURLToPath(new URL('../config-schema.json', import.meta.url));
const docsSchemaPath = fileURLToPath(
	new URL('../../../docs/public/config-schema.json', import.meta.url),
);

await copyFile(packageSchemaPath, docsSchemaPath);
