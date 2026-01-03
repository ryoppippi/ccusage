import { homedir } from 'node:os';
import path from 'node:path';

export const USER_HOME_DIR = homedir();

export const PI_AGENT_DIR_ENV = 'PI_AGENT_DIR';
export const PI_AGENT_SESSIONS_DIR_NAME = 'sessions';
export const DEFAULT_PI_AGENT_PATH = path.join('.pi', 'agent');
