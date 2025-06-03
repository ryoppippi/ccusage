import { type ConsolaInstance, consola } from "consola";

import { name } from "../package.json";

export const logger: ConsolaInstance = consola.withTag(name);

export const log = console.log;
