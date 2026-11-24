// Review: the queue of pull requests (/review) and one pull request (/review/:projectId/:number).
import { Navigate, useParams, useSearchParams } from "react-router";
import { PrPage } from "./review/PrPage.tsx";
import { ReviewQueue } from "./review/Queue.tsx";

export function ReviewRoute() {
  return <ReviewQueue />;
}

export function PrRoute() {
  const { projectId, number } = useParams();
  const [params] = useSearchParams();
  const n = Number(number);
  if (!projectId || !Number.isInteger(n) || n <= 0) return <Navigate to="/review" replace />;
  // Another repository on the host rides in the query (model.ts prPath).
  const repo = params.get("repo") ?? undefined;
  const host = params.get("host") ?? undefined;
  // Keyed: another pull request is a fresh page (scroll, tabs, selection).
  return <PrPage key={`${projectId}#${repo ?? ""}#${n}`} pr={{ project_id: projectId, number: n, repo, host }} />;
}
