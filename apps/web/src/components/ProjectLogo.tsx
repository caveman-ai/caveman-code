// A project's mark where its folder would be: its logo (Project.logo, an image kept by id), 16px with 4px corners,
// else its supplied fallback (the sidebar's Chief), or the pixel folder. Failed images use the same fallback.
import { PixelFolder } from "@caveman-app/ui/icons/PixelIcon";
import { type ReactNode, useState } from "react";
import { useProjectLogoUrl } from "../state/project-logos.ts";

export function ProjectLogo({
  projectId,
  logo,
  open = false,
  className,
  fallback,
}: {
  projectId: string;
  logo: { readonly id: string } | undefined;
  open?: boolean;
  className?: string;
  fallback?: ReactNode;
}) {
  const url = useProjectLogoUrl(projectId, logo);
  const [broken, setBroken] = useState<string | null>(null);
  if (url === undefined || broken === url)
    return (
      fallback ?? <PixelFolder open={open} {...(className !== undefined ? { className } : {})} />
    );
  // alt="": the project's name is beside it.
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onError={() => setBroken(url)}
      className="size-4 shrink-0 rounded-[4px] object-contain"
    />
  );
}
