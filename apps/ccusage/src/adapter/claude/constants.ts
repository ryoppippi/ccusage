import path from 'node:path';
import { XDG_CONFIG_DIR } from '../../consts.ts';

export const DEFAULT_CLAUDE_CODE_PATH = '.claude';
export const DEFAULT_CLAUDE_CONFIG_PATH = path.join(XDG_CONFIG_DIR, 'claude');
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_PROJECTS_DIR_NAME = 'projects';
