import process from "node:process";
import { type ConsolaInstance, consola } from "consola";

import { name } from "./package.json";

export const logger: ConsolaInstance = consola.withTag(name);
