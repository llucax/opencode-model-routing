// The OpenCode plugin: adds the model_route tool. OpenCode's loader calls
// every export of this file as a plugin, so it has only the default one.

import type { Plugin } from "@opencode-ai/plugin";
import { createTool } from "./tool.ts";

export default (async (input) => ({ tool: { model_route: createTool(input) } })) satisfies Plugin;
