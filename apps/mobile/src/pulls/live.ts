// The person's pull requests in the running app: the one store (store.ts) on the phone's own Cloud client and toast,
// the hooks the Needs you list and a pull request's screen read it with, and the two things that leave the page
// (GitHub's connect page in the browser, a chat in Cloud about a pull request). Only for someone signed in: on the
// scripted board, and signed out, nothing here reads or draws.
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import type { PrSummary } from "@caveman-app/session-protocol";

import { CLOUD } from "../board/model";
import { addProject } from "../board/places";
import { theCloud, useLink } from "../live/link";
import { openUrl } from "../live/native";
import { startLive } from "../live/seams";
import { showChat } from "../nav/ref";
import { notice } from "../shell/ui";
import { useSelector } from "../store/core";
import { type ListView, listView, NO_PULLS, projectNameOf, pullKey } from "./model";
import { createPulls, NO_PULL, type PullState } from "./store";
import { askText } from "./words";

/** What a change did is said in the shell's toast, with the done check ("Approved", "Merged"). */
export const pulls = createPulls({
  cloud: theCloud,
  say: (text) => notice({ id: `pull-${Date.now()}`, text, tone: "done" }),
});

/** Who is signed in to Caveman on this phone, by email; null when nobody is, or it is not read yet. */
export const usePerson = (): string | null => useLink((s) => s.account?.email ?? null);

/**
 * What a list draws of pull requests (model.ts listView). With `on`, and someone signed in, the list is read as the
 * place that shows it comes to the front (`focused`): when it opens, and each time it is come back to. Never in the
 * background.
 */
export function usePullListWhile(on: boolean, focused: boolean): ListView {
  const person = usePerson();
  const offline = useLink((s) => s.offlineSince !== null);
  const active = on && person !== null;
  const list = useSelector(pulls.store, (s) => (s.person === person ? s.list : null));
  const reading = useSelector(pulls.store, (s) => s.person === person && s.reading);
  const problem = useSelector(pulls.store, (s) => (s.person === person ? s.problem : null));
  const view = useMemo(
    () => (active ? listView({ list, reading, problem }) : NO_PULLS),
    [active, list, reading, problem],
  );

  useEffect(() => {
    if (on && focused && person !== null) void pulls.readList(person);
  }, [on, focused, person]);
  // A list that could not be read for want of a network is read once the phone is back online.
  useEffect(() => {
    if (on && focused && person !== null && !offline && pulls.store.get().problem !== null)
      void pulls.readList(person);
  }, [on, focused, offline, person]);
  // GitHub connects in the browser: coming back to the app reads again, with nothing to press.
  const connecting = view.kind === "connect";
  useEffect(() => {
    if (!on || !focused || !connecting || person === null) return;
    const heard = AppState.addEventListener("change", (state) => {
      if (state === "active") void pulls.readList(person);
    });
    return () => heard.remove();
  }, [on, focused, connecting, person]);
  return view;
}

/** The Needs you list's, on its own screen: in front while that screen is. */
export const usePullList = (on: boolean): ListView => usePullListWhile(on, useIsFocused());

/** Reads the list again, for a pull to refresh; resolves once it is read. */
export const refreshPullList = (person: string | null): Promise<void> =>
  person === null ? Promise.resolve() : pulls.readList(person);

/** One pull request as the phone holds it; read as its screen opens. */
export function usePull(repo: string, number: number): PullState {
  const person = usePerson();
  const key = pullKey(repo, number);
  const state = useSelector(pulls.store, (s) => (s.person === person ? s.pulls[key] : undefined));
  useEffect(() => {
    if (person !== null) void pulls.open(person, repo, number);
  }, [person, repo, number]);
  return state ?? NO_PULL;
}

/** Whether a chat can start in Cloud from this phone: this Caveman runs Cloud for the person, or they have chats there. */
export const useCloudStarts = (): boolean =>
  useLink((s) => s.cloud || (s.computers ?? []).some((c) => c.kind === "cloud"));

/** Opens where GitHub connects, in the phone's browser. */
export const connectGitHub = (url: string) => openUrl(url);

/**
 * Starts a chat in Cloud about a pull request and opens it. Its repository becomes a project if it is not one yet
 * (named by the repository's own name, as every computer names it); the chat runs on whatever agent Cloud runs for
 * the person. False when nothing was started: the start says why itself.
 */
export function askAgent(
  pr: Pick<PrSummary, "number" | "title" | "repo" | "url" | "head_branch">,
): boolean {
  let project = addProject({ name: projectNameOf(pr.repo), github: pr.repo });
  // A project of the same name that is another repository: this one goes by its full name.
  if ((project.github ?? "").toLowerCase() !== pr.repo.toLowerCase())
    project = addProject({ name: pr.repo, github: pr.repo });
  const chat = startLive({
    text: askText(pr),
    repo: project.name,
    device: CLOUD.id,
    engine: "caveman",
    model: "",
    picked: false,
  });
  if (!chat) return false;
  showChat(chat);
  return true;
}
