// @qorechain/rdk touches Node's Buffer in a couple of places; give the browser one.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
