import {defineConfig} from 'vitest/config';
import {fileURLToPath,URL} from 'node:url';
export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('../../src',import.meta.url))}},test:{environment:'node',include:['outputs/rtc-generation-audit-20261004/*.test.ts']}});
