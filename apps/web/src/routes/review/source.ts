// Where the Review page reads from: This Mac's runtime, or Cloud on the person's own session. A browser window with
// no Mac (useWebWindow: nothing put it on one) has nothing that can read GitHub for the person, so it reads Cloud's
// Review routes (CONTRACT §12): the queue, a pull request, its diff and discussion, and the changes only a person
// makes (approve, request changes, comment, merge). The page is the same; the source says what it can offer, and the
// page draws nothing Cloud would refuse.
import type { Client } from "@caveman-app/session-protocol/client";
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { GITHUB_CONNECT_PATH } from "../../state/cloud.ts";
import { useRuntimeClient, useWebWindow, type WebWindowValue } from "../../state/runtime.tsx";
import { CloudError, cloudRequester, cookieAuth } from "../../state/sync/cloud-api.ts";

export type ReviewFrom = "mac" | "cloud";

/** What the page may draw beyond reading and the four changes, by source. */
export interface ReviewOffers {
  /** The review guide and its TL;DR: a model run on a computer. */
  readonly guide: boolean;
  /** A file's viewed mark kept on GitHub (GraphQL only); without it the mark is this device's. */
  readonly viewed: boolean;
  /** A thread's resolved state and Resolve (GraphQL only). */
  readonly resolve: boolean;
  /** Unchanged lines past a file's patch, and the whole file. */
  readonly expand: boolean;
  /** Where a name is used across the repository (a checkout's git grep). */
  readonly symbols: boolean;
  /** Mark a draft ready for review (GraphQL only). */
  readonly ready: boolean;
}

export const MAC_OFFERS: ReviewOffers = {
  guide: true,
  viewed: true,
  resolve: true,
  expand: true,
  symbols: true,
  ready: true,
};
export const CLOUD_OFFERS: ReviewOffers = {
  guide: false,
  viewed: false,
  resolve: false,
  expand: false,
  symbols: false,
  ready: false,
};

export interface ReviewSource {
  readonly client: Client | null;
  readonly from: ReviewFrom;
  readonly offers: ReviewOffers;
}

/** Cloud when a browser window has no Mac to read through (`web` is null off the web: the desktop's own Mac). */
export const reviewFrom = (web: Pick<WebWindowValue, "home"> | null): ReviewFrom =>
  web !== null && web.home?.kind !== "mac" ? "cloud" : "mac";

/** What Cloud says when it keeps no GitHub link of the person's (code/reviews.go reviewNotConnected). */
export const CONNECT_GITHUB = "Connect GitHub to review pull requests here.";
/** Opens where GitHub connects, in a tab of its own: coming back reads again by itself. */
export const connectGitHub = (url?: string) =>
  void window.open(url ?? GITHUB_CONNECT_PATH, "_blank", "noopener");

/** Cloud's refusal when a pull request is read without its repository (an address only a Mac's project names). */
export const NO_REPOSITORY = "Open it from Review to read it here.";
/** Anything the page asks that Cloud does not serve (offers keep the page from asking). */
export const CLOUD_DOES_NOT = "Do this on your Mac (Review), or on GitHub.";

type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** The cache tag of a Cloud source, so its queue never shows as a Mac's (data.ts). */
const CLOUD_TAG = Symbol("review-from-cloud");
export const sourceTag = (client: Client | null): string =>
  client && (client as unknown as Record<symbol, unknown>)[CLOUD_TAG] ? ":cloud" : "";

/** `owner/name` and number as Cloud's path names them. */
function prPath(params: Record<string, unknown>, rest = ""): string {
  const repo = typeof params.repo === "string" ? params.repo : "";
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new CloudError(404, "cave_not_found", NO_REPOSITORY);
  return `/api/v1/code/reviews/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${Number(params.number)}${rest}`;
}

/**
 * Cloud's Review routes as the page's client: the same pr.* calls a runtime answers, in the same shapes (Cloud answers
 * the protocol's PrSummary, PrDetail, PrDiff and discussion items). Anything else is refused without asking Cloud.
 */
export function cloudReviewClient(request: Request): Client {
  const json = async (path: string, init?: RequestInit) =>
    (await request(path, init)).json() as Promise<unknown>;
  const post = (path: string, body: unknown) =>
    json(path, { method: "POST", body: JSON.stringify(body) }).then(() => ({}));
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    switch (method) {
      case "pr.list":
        return json("/api/v1/code/reviews");
      case "pr.get":
        return json(prPath(params));
      case "pr.diff":
        return json(prPath(params, "/diff"));
      case "pr.discussion":
        return json(prPath(params, "/discussion"));
      case "pr.review":
        return post(prPath(params, "/review"), {
          verdict: params.verdict,
          ...(typeof params.body === "string" && params.body ? { body: params.body } : {}),
        });
      case "pr.comment": {
        const { body, path, line, side, thread_id } = params;
        return post(prPath(params, "/comments"), {
          body,
          ...(path !== undefined ? { path, line, ...(side ? { side } : {}) } : {}),
          ...(thread_id !== undefined ? { thread_id } : {}),
        });
      }
      case "pr.merge":
        return post(prPath(params, "/merge"), {
          method: params.method,
          ...(typeof params.head_sha === "string" ? { head_sha: params.head_sha } : {}),
        });
    }
    throw new CloudError(400, "unsupported", CLOUD_DOES_NOT);
  };
  return { call, [CLOUD_TAG]: true } as unknown as Client;
}

let shared: Client | null = null;
/** The web build's own Cloud: same origin, the session cookie. One for the page's life, so its reads are cached once. */
const webCloudClient = () => (shared ??= cloudReviewClient(cloudRequester(cookieAuth())));

const ReviewSourceContext = createContext<ReviewSource | null>(null);
/** A fixture page's or a test's own source (shell/review-cloud.browser.tsx). */
export function ReviewSourceFixture({
  value,
  children,
}: {
  value: ReviewSource;
  children: ReactNode;
}) {
  return createElement(ReviewSourceContext.Provider, { value }, children);
}

/**
 * Where this window's Review page reads from, and what it offers there. `address`: a pull request named only by a
 * Mac's project (no repository: a chat's own tab) stays with the runtime, which knows that project.
 */
export function useReviewSource(address?: { readonly repo?: string | undefined }): ReviewSource {
  const fixed = useContext(ReviewSourceContext);
  const { client } = useRuntimeClient();
  const web = reviewFrom(useWebWindow());
  const from: ReviewFrom = web === "cloud" && address !== undefined && !address.repo ? "mac" : web;
  return useMemo<ReviewSource>(
    () =>
      fixed ??
      (from === "cloud"
        ? { client: webCloudClient(), from, offers: CLOUD_OFFERS }
        : { client, from, offers: MAC_OFFERS }),
    [fixed, from, client],
  );
}

/**
 * Only what the page may draw here, for parts that never read through a client (a thread, a file's viewed box): a
 * fixture's, else Cloud's in a browser window with no Mac, else a Mac's. Needs no runtime.
 */
export function useReviewOffers(): ReviewOffers {
  const fixed = useContext(ReviewSourceContext);
  const from = reviewFrom(useWebWindow());
  return fixed?.offers ?? (from === "cloud" ? CLOUD_OFFERS : MAC_OFFERS);
}
