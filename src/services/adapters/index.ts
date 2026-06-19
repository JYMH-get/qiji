import { registerAdapter } from "./registry";
import { gvlmTextAdapter } from "./gvlmTextAdapter";
import { gvlmScriptAdapter } from "./gvlmScriptAdapter";
import { libImageAdapter } from "./libImageAdapter";
import { seedanceAdapter } from "./seedanceAdapter";
import { libAudioAdapter } from "./libAudioAdapter";
import { mockAdapter } from "./mockAdapter";

for (const a of [
  gvlmTextAdapter,
  gvlmScriptAdapter,
  libImageAdapter,
  seedanceAdapter,
  libAudioAdapter,
  mockAdapter,
]) {
  registerAdapter(a);
}