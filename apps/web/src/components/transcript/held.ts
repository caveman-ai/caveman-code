// The steps an open approval holds (its tool call): they wait on the person, so their line stops ticking and
// shimmering until the answer comes. The transcript provides them; a step line and its run read them.
import { createContext } from "react";

export const HeldSteps = createContext<ReadonlySet<string>>(new Set());
