// A synchronous, SQLite-backed localStorage on iOS and Android (it is in Expo Go), installed before anything reads it:
// the store reads the last session from it before the first frame (src/store/persist.ts). The web keeps the
// browser's own and starts from index.web.ts.
import "expo-sqlite/localStorage/install";
import { registerRootComponent } from "expo";
import { installCrypto } from "./src/live/native";
import App from "./src/App";

// A phone's JavaScript engine has no WebCrypto: the phone's own goes in before anything asks for it (live/webcrypto.ts).
void installCrypto();

registerRootComponent(App);
