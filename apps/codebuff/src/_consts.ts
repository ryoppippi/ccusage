import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Environment variable name for custom Codebuff data directory (points at the
 * equivalent of `~/.config/manicode`).
 */
export const CODEBUFF_DATA_DIR_ENV = 'CODEBUFF_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();

/**
 * Default base path for Codebuff installations (production channel). Codebuff
 * ships under the legacy `manicode` folder name because the product was
 * originally called Manicode.
 */
export const DEFAULT_CODEBUFF_DIR = path.join(USER_HOME_DIR, '.config', 'manicode');

/**
 * Codebuff release channels. Each one is laid out under `~/.config/<channel>`.
 */
export const CODEBUFF_CHANNELS = ['manicode', 'manicode-dev', 'manicode-staging'] as const;

/**
 * Sub-directory under a Codebuff channel root where per-project chat history is stored.
 */
export const CODEBUFF_PROJECTS_DIR_NAME = 'projects';

/**
 * Sub-directory under `projects/<projectBasename>/` that holds chat sessions.
 */
export const CODEBUFF_CHATS_DIR_NAME = 'chats';

/**
 * File name within each chat directory containing serialized ChatMessage[].
 */
export const CODEBUFF_CHAT_MESSAGES_FILE = 'chat-messages.json';

/**
 * File name within each chat directory containing the SDK RunState snapshot.
 */
export const CODEBUFF_RUN_STATE_FILE = 'run-state.json';

/**
 * Million constant for pricing calculations.
 */
export const MILLION = 1_000_000;
