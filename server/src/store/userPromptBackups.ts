import { db } from './sqlite.ts';
import { createUserPromptBackupStore } from '../userPromptBackupsCore.ts';
export const userPromptBackups = createUserPromptBackupStore(db);
