// Tests run as the runtime does: on Windows a bare command name is never looked for in the current directory
// (bin.ts sets this at its start; exeSearch.ts). resolveSpawnCommand then passes a name PATH lacks on to a fake
// spawner as before, where PATH is absolute; its own tests set the host environment they mean.
import { stopCurrentDirectoryExeSearch } from "../exeSearch.ts";

stopCurrentDirectoryExeSearch();
